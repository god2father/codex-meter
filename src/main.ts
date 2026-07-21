import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./style.css";

type UsageStatus = "ok" | "limit_reached" | "unavailable" | "signed_out" | "api_key_unsupported" | "stale" | "error";

interface LimitWindow {
  usedPercent: number;
  remainingPercent?: number;
  windowDurationMins: number;
  resetsAt: number | null;
}

interface UsageSnapshot {
  accountType?: string;
  planType?: string;
  primary: LimitWindow | null;
  secondary?: LimitWindow | null;
  creditsBalance?: number | null;
  status: UsageStatus;
  fetchedAt: number;
  error?: string | null;
}

interface PanelPosition {
  anchorX: number;
  anchorY: number;
  edge: "top" | "bottom" | "left" | "right";
}

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
  }
}

const isTauri = Boolean(window.__TAURI_INTERNALS__);
document.documentElement.dataset.runtime = isTauri ? "tauri" : "browser";
const mockSnapshot: UsageSnapshot = {
  accountType: "ChatGPT",
  planType: "Plus",
  primary: {
    usedPercent: 32,
    remainingPercent: 68,
    windowDurationMins: 300,
    resetsAt: Math.floor(Date.now() / 1000) + 2.5 * 60 * 60,
  },
  secondary: {
    usedPercent: 55,
    remainingPercent: 45,
    windowDurationMins: 10080,
    resetsAt: Math.floor(Date.now() / 1000) + 4.2 * 24 * 60 * 60,
  },
  creditsBalance: null,
  status: "ok",
  fetchedAt: Math.floor(Date.now() / 1000),
};

const CACHE_KEY = "codex-meter:last-usage";
let snapshot: UsageSnapshot | null = isTauri ? loadCachedSnapshot() : mockSnapshot;
let loading = isTauri && !snapshot;
let refreshing = false;
let errorMessage = "";
let settingsOpen = false;
let panelPosition: PanelPosition = { anchorX: 160, anchorY: 160, edge: "bottom" };
let lastPanelSize = "";
let panelSyncFrame = 0;
let panelResizeObserver: ResizeObserver | null = null;

const app = document.querySelector<HTMLElement>("#app")!;

const clampPercent = (value: number) => Math.max(0, Math.min(100, Math.round(value)));

function formatWindow(minutes: number): string {
  if (minutes === 300) return "5 小时";
  if (minutes === 10080) return "每周";
  if (minutes % 1440 === 0) return `${minutes / 1440} 天`;
  if (minutes % 60 === 0) return `${minutes / 60} 小时`;
  return `${minutes} 分钟`;
}

function formatPlan(plan: string): string {
  const knownPlans: Record<string, string> = {
    free: "Free",
    go: "Go",
    plus: "Plus",
    pro: "Pro",
    team: "Team",
    business: "Business",
    enterprise: "Enterprise",
    edu: "Edu",
  };
  return knownPlans[plan.toLowerCase()] ?? plan;
}

function formatReset(unixSeconds: number | null): string {
  if (unixSeconds === null) return "重置时间未知";
  const date = new Date(unixSeconds * 1000);
  const now = new Date();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  const sameDay = date.toDateString() === now.toDateString();
  const nextDay = date.toDateString() === tomorrow.toDateString();
  const time = new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  if (sameDay) return `今天 ${time} 重置`;
  if (nextDay) return `明天 ${time} 重置`;
  return `${new Intl.DateTimeFormat("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date)} 重置`;
}

function formatUpdated(unixSeconds: number): string {
  const elapsed = Math.max(0, Math.floor(Date.now() / 1000) - unixSeconds);
  if (elapsed < 10) return "刚刚更新";
  if (elapsed < 60) return `${elapsed} 秒前更新`;
  if (elapsed < 3600) return `${Math.floor(elapsed / 60)} 分钟前更新`;
  return `${Math.floor(elapsed / 3600)} 小时前更新`;
}

function tightestWindow(data: UsageSnapshot): LimitWindow | null {
  if (!data.primary) return data.secondary ?? null;
  if (!data.secondary) return data.primary;
  return remainingOf(data.secondary) < remainingOf(data.primary)
    ? data.secondary
    : data.primary;
}

function remainingOf(item: LimitWindow): number {
  return clampPercent(100 - item.usedPercent);
}

function statusCopy(): { label: string; detail: string } {
  if (loading) return { label: "正在获取用量", detail: "正在连接 Codex" };
  if (errorMessage && !snapshot) return { label: "暂时无法获取", detail: errorMessage };
  if (!snapshot?.primary && !snapshot?.secondary) {
    if (snapshot?.status === "signed_out") return { label: "尚未登录", detail: "请先在 Codex 中登录 ChatGPT" };
    if (snapshot?.status === "api_key_unsupported") return { label: "当前为 API Key 模式", detail: "订阅额度仅支持 ChatGPT 登录" };
    return { label: "暂无额度数据", detail: snapshot?.error || "Codex 未返回可用窗口" };
  }
  if (snapshot?.status === "stale" || errorMessage) {
    return { label: "数据可能已过期", detail: errorMessage || "正在等待下次刷新" };
  }
  if (snapshot?.status === "limit_reached") return { label: "额度已用尽", detail: "等待额度窗口重置" };
  return { label: "状态良好", detail: "来自 Codex 官方服务" };
}

function loadCachedSnapshot(): UsageSnapshot | null {
  try {
    const value = localStorage.getItem(CACHE_KEY);
    if (!value) return null;
    const cached = normalizeSnapshot(JSON.parse(value));
    if (!tightestWindow(cached)) return null;
    return { ...cached, status: "stale" };
  } catch {
    return null;
  }
}

function saveSnapshot(value: UsageSnapshot): void {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(value));
  } catch {
    // Cache failure should never block live usage display.
  }
}

function icon(name: "refresh" | "settings" | "exit" | "clock" | "check" | "alert"): string {
  const paths = {
    refresh: '<path d="M20 11a8.1 8.1 0 1 0 .1 4M20 4v7h-7"/>',
    settings: '<path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H3v-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V3h4v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/>',
    exit: '<path d="M10 5H5v14h5M14 8l4 4-4 4M9 12h9"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>',
    check: '<circle cx="12" cy="12" r="8"/><path d="m8.5 12 2.2 2.2 4.8-5"/>',
    alert: '<path d="M12 3 2.8 19h18.4L12 3Z"/><path d="M12 9v4M12 16.5v.1"/>',
  };
  return `<svg aria-hidden="true" viewBox="0 0 24 24">${paths[name]}</svg>`;
}

function renderLimitRow(item: LimitWindow): string {
  const remaining = remainingOf(item);
  return `
    <div class="limit-row">
      <div class="limit-meta">
        <span class="window-name">${formatWindow(item.windowDurationMins)}</span>
        <span class="reset-time">${formatReset(item.resetsAt)}</span>
      </div>
      <div class="limit-value"><strong>${remaining}%</strong><span>剩余</span></div>
      <div class="track" aria-hidden="true"><i style="width:${remaining}%"></i></div>
    </div>`;
}

function render(): void {
  const data = snapshot;
  const tightest = data ? tightestWindow(data) : null;
  const remaining = tightest ? remainingOf(tightest) : 0;
  const hasUsage = Boolean(data && tightest);
  const reached = data?.status === "limit_reached";
  const state = loading ? "loading" : !hasUsage || reached ? "error" : data?.status === "stale" || errorMessage ? "stale" : "ok";
  const status = statusCopy();

  app.innerHTML = `
    <div class="panel-shell">
    <section class="glass-card" data-state="${state}" aria-label="Codex 用量">
      <div class="shine" aria-hidden="true"></div>
      <header>
        <div>
          <div class="brand-line">
            <h1>Codex Meter</h1>
            ${!isTauri ? '<span class="mock-badge">演示数据</span>' : ""}
          </div>
          <p class="status-line" role="status" aria-live="polite"><i></i><span>${status.label}</span></p>
        </div>
        <div class="header-actions">
          <button class="icon-button" data-action="refresh" aria-label="刷新用量" title="刷新用量" ${refreshing ? "disabled" : ""}>${icon("refresh")}</button>
          <button class="icon-button" data-action="settings" aria-label="偏好设置" title="偏好设置" aria-expanded="${settingsOpen}" aria-controls="settings-panel">${icon("settings")}</button>
        </div>
      </header>

      ${settingsOpen ? `
        <div class="settings-panel settings-view" id="settings-panel">
          <div><span>界面主题</span><strong>跟随系统</strong></div>
          <div><span>自动刷新</span><strong>每 1 分钟</strong></div>
          <p>设置将在后续版本开放编辑。</p>
        </div>` : data && tightest ? `
        <div class="overview">
          <div class="ring" style="--progress:${remaining * 3.6}deg" role="img" aria-label="最紧张窗口剩余 ${remaining}%">
            <div><strong>${remaining}</strong><span>%</span></div>
          </div>
          <div class="summary">
            <span>当前可用</span>
            <strong>${formatWindow(tightest!.windowDurationMins)}窗口</strong>
            <small>${data.planType ? `${formatPlan(data.planType)} 计划` : "当前账户"}</small>
          </div>
        </div>
        <div class="limits" aria-label="用量窗口">
          ${data.primary ? renderLimitRow(data.primary) : ""}
          ${data.secondary ? renderLimitRow(data.secondary) : ""}
        </div>` : `
        <div class="empty-state" role="status">
          <span class="empty-icon">${loading ? '<i class="spinner"></i>' : icon("alert")}</span>
          <strong>${status.label}</strong>
          <p>${status.detail}</p>
          ${!loading ? '<button class="text-button" data-action="refresh">重新尝试</button>' : ""}
        </div>`}

      <footer>
        <div class="updated" title="${status.detail}">
          ${icon(state === "ok" ? "check" : state === "loading" ? "clock" : "alert")}
          <span>${refreshing ? "正在刷新…" : data ? formatUpdated(data.fetchedAt) : status.detail}</span>
        </div>
        <div class="footer-actions">
          <button class="text-button" data-action="refresh" ${refreshing ? "disabled" : ""}>立即刷新</button>
          <button class="icon-button exit" data-action="exit" aria-label="退出 Codex Meter" title="退出">${icon("exit")}</button>
        </div>
      </footer>
    </section>
    <span class="bubble-tail" aria-hidden="true"></span>
    </div>`;
  observePanelSize();
  schedulePanelSync();
}

function applyPanelPosition(): void {
  const shell = app.querySelector<HTMLElement>(".panel-shell");
  if (!shell) return;
  document.documentElement.dataset.panelEdge = panelPosition.edge;
  const rect = shell.getBoundingClientRect();
  const tailX = Math.max(18, Math.min(rect.width - 18, panelPosition.anchorX - rect.left));
  const tailY = Math.max(18, Math.min(rect.height - 18, panelPosition.anchorY - rect.top));
  shell.style.setProperty("--tail-x", `${tailX}px`);
  shell.style.setProperty("--tail-y", `${tailY}px`);
}

function observePanelSize(): void {
  if (!isTauri || typeof ResizeObserver === "undefined") return;
  const shell = app.querySelector<HTMLElement>(".panel-shell");
  if (!shell) return;
  panelResizeObserver?.disconnect();
  panelResizeObserver = new ResizeObserver(() => schedulePanelSync());
  panelResizeObserver.observe(shell);
}

function schedulePanelSync(): void {
  if (!isTauri) return;
  window.cancelAnimationFrame(panelSyncFrame);
  panelSyncFrame = window.requestAnimationFrame(() => {
    const shell = app.querySelector<HTMLElement>(".panel-shell");
    if (!shell) return;
    const bodyStyle = getComputedStyle(document.body);
    const width = Math.ceil(shell.offsetWidth + parseFloat(bodyStyle.paddingLeft) + parseFloat(bodyStyle.paddingRight));
    const height = Math.ceil(shell.offsetHeight + parseFloat(bodyStyle.paddingTop) + parseFloat(bodyStyle.paddingBottom));
    applyPanelPosition();
    const nextSize = `${width}x${height}`;
    if (nextSize === lastPanelSize) return;
    lastPanelSize = nextSize;
    void invoke("resize_panel", { width, height }).catch(() => undefined);
  });
}

function normalizeSnapshot(value: unknown): UsageSnapshot {
  if (!value || typeof value !== "object") throw new Error("Codex 返回了无效数据");
  const candidate = value as UsageSnapshot;
  const windows = [candidate.primary, candidate.secondary].filter(Boolean) as LimitWindow[];
  if (windows.some((item) => typeof item.usedPercent !== "number" || typeof item.windowDurationMins !== "number")) {
    throw new Error("用量数据不完整");
  }
  return candidate;
}

async function refreshUsage(): Promise<void> {
  if (refreshing) return;
  if (!isTauri) {
    snapshot = { ...mockSnapshot, fetchedAt: Math.floor(Date.now() / 1000) };
    errorMessage = "";
    render();
    await updateTrayIcon(snapshot);
    return;
  }

  refreshing = true;
  loading = !snapshot;
  errorMessage = "";
  render();
  try {
    const next = normalizeSnapshot(await invoke("refresh_usage"));
    if (tightestWindow(next)) {
      snapshot = next;
      errorMessage = next.error || "";
      if (!next.error) saveSnapshot(next);
      await updateTrayIcon(next);
    } else if (snapshot && tightestWindow(snapshot)) {
      errorMessage = next.error || statusCopyFor(next.status);
      snapshot = { ...snapshot, status: "stale" };
      await updateTrayIcon(snapshot);
    } else {
      snapshot = next;
      errorMessage = next.error || "";
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
    if (snapshot && tightestWindow(snapshot)) {
      snapshot = { ...snapshot, status: "stale" };
      await updateTrayIcon(snapshot);
    }
  } finally {
    loading = false;
    refreshing = false;
    render();
  }
}

async function updateTrayIcon(data: UsageSnapshot): Promise<void> {
  if (!isTauri) return;
  const size = 32;
  const canvas = document.createElement("canvas");
  canvas.width = size;
  canvas.height = size;
  const context = canvas.getContext("2d");
  if (!context) return;
  const tightest = tightestWindow(data);
  if (!tightest) return;
  const remaining = remainingOf(tightest);
  const color = data.status === "error" ? "#ff6b6b" : data.status === "stale" ? "#ffb84d" : "#39d7dc";
  context.clearRect(0, 0, size, size);
  context.lineWidth = 3;
  context.lineCap = "round";
  context.strokeStyle = "rgba(127, 138, 160, .45)";
  context.beginPath();
  context.arc(16, 16, 13, 0, Math.PI * 2);
  context.stroke();
  context.strokeStyle = color;
  context.beginPath();
  context.arc(16, 16, 13, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * remaining / 100);
  context.stroke();
  context.fillStyle = window.matchMedia("(prefers-color-scheme: dark)").matches ? "#ffffff" : "#18202b";
  context.font = "700 12px system-ui";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(String(remaining), 16, 16.5);
  const rgba = Array.from(context.getImageData(0, 0, size, size).data);
  try {
    await invoke("update_tray_icon", { rgba, width: size, height: size });
  } catch {
    // Older backends may not expose dynamic tray icons; usage UI remains functional.
  }
}

function statusCopyFor(status: UsageStatus): string {
  if (status === "signed_out") return "请先在 Codex 中登录 ChatGPT";
  if (status === "api_key_unsupported") return "API Key 模式没有订阅额度数据";
  return "Codex 暂未返回额度数据";
}

app.addEventListener("click", async (event) => {
  const button = (event.target as Element).closest<HTMLButtonElement>("button[data-action]");
  if (!button) return;
  switch (button.dataset.action) {
    case "refresh":
      await refreshUsage();
      break;
    case "settings":
      settingsOpen = !settingsOpen;
      render();
      app.querySelector<HTMLButtonElement>('[data-action="settings"]')?.focus();
      if (isTauri && settingsOpen) void invoke("open_settings").catch(() => undefined);
      break;
    case "exit":
      if (isTauri) await invoke("quit_app");
      else window.close();
      break;
  }
});

render();

if (isTauri) {
  document.addEventListener("contextmenu", (event) => event.preventDefault());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") void invoke("hide_panel").catch(() => undefined);
  });
  void listen("usage://refresh-requested", () => void refreshUsage());
  void listen("settings://open", () => {
    settingsOpen = true;
    render();
  });
  void listen<PanelPosition>("panel://positioned", ({ payload }) => {
    panelPosition = payload;
    applyPanelPosition();
  });
  void refreshUsage();
} else {
  void updateTrayIcon(mockSnapshot);
}

window.setInterval(() => {
  const updated = app.querySelector<HTMLElement>(".updated span");
  if (snapshot && updated && !refreshing) updated.textContent = formatUpdated(snapshot.fetchedAt);
}, 30_000);

window.setInterval(() => void refreshUsage(), 60_000);

window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (snapshot) void updateTrayIcon(snapshot);
});
