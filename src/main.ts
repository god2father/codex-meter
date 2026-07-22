import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import {
  disable as disableAutostart,
  enable as enableAutostart,
  isEnabled as isAutostartEnabled,
} from "@tauri-apps/plugin-autostart";
import "./style.css";

type UsageStatus = "ok" | "limit_reached" | "unavailable" | "signed_out" | "api_key_unsupported" | "stale" | "error";
type DataFreshness = "fresh" | "reconnecting" | "expired" | "loading" | "unavailable";
type CatMood = "healthy" | "warning" | "critical" | "exhausted" | "sleeping" | "neutral";
type RuntimePlatform = "windows" | "macos" | "other";

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
  resetCreditsAvailable?: number | null;
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
  resetCreditsAvailable: 2,
  status: "ok",
  fetchedAt: Math.floor(Date.now() / 1000),
};

const CACHE_KEY = "codex-meter:last-usage";
const STALE_AFTER_SECONDS = 5 * 60;
const themeQuery = window.matchMedia("(prefers-color-scheme: dark)");
const reducedMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
let snapshot: UsageSnapshot | null = isTauri ? loadCachedSnapshot() : mockSnapshot;
let runtimePlatform: RuntimePlatform = isTauri ? "other" : "windows";
let loading = isTauri && !snapshot;
let refreshing = false;
let errorMessage = "";
let settingsOpen = false;
let autostartEnabled = !isTauri;
let autostartLoading = isTauri;
let autostartError = "";
let panelPosition: PanelPosition = { anchorX: 160, anchorY: 160, edge: "bottom" };
let lastPanelSize = "";
let panelSyncFrame = 0;
let panelResizeObserver: ResizeObserver | null = null;
let lastRenderedFreshness: DataFreshness | null = null;
let trayAnimationRunning = false;
let freshnessExpiryTimer = 0;

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

function hasUsage(data: UsageSnapshot | null): data is UsageSnapshot {
  return Boolean(data && tightestWindow(data));
}

function snapshotAgeSeconds(data: UsageSnapshot): number {
  return Math.max(0, Math.floor(Date.now() / 1000) - data.fetchedAt);
}

function dataAgeMinutes(data: UsageSnapshot): number {
  return Math.max(1, Math.floor(snapshotAgeSeconds(data) / 60));
}

function dataFreshness(): DataFreshness {
  if (!hasUsage(snapshot)) return loading || refreshing ? "loading" : "unavailable";
  if (snapshotAgeSeconds(snapshot) >= STALE_AFTER_SECONDS) return "expired";
  if (snapshot.status === "stale" || errorMessage) return "reconnecting";
  return "fresh";
}

function usageTone(remaining: number): "healthy" | "warning" | "critical" {
  if (remaining >= 50) return "healthy";
  if (remaining >= 20) return "warning";
  return "critical";
}

function usageColor(remaining: number): string {
  if (usageTone(remaining) === "warning") return "#f2ae42";
  if (usageTone(remaining) === "critical") return "#f16676";
  return "#39d7bc";
}

function usageQuip(remaining: number): string {
  if (remaining >= 90) return "额度富得流油，今天可以放肆写。";
  if (remaining >= 75) return "钱包鼓鼓，Codex 还能继续加班。";
  if (remaining >= 55) return "粮草充足，放心把需求往里倒。";
  if (remaining >= 35) return "进入正常消耗区，暂时不用抠门。";
  if (remaining >= 20) return "额度开始喘气，需求尽量一次说清。";
  if (remaining >= 10) return "Codex 在看表了，长任务请三思。";
  if (remaining > 0) return "只剩最后几口，省着点薅它。";
  return "额度已躺平，等重置后再卷。";
}

function statusCopy(freshness = dataFreshness()): { label: string; detail: string } {
  if (freshness === "loading") return { label: "正在获取用量", detail: "正在连接 Codex" };
  if (errorMessage && !snapshot) return { label: "暂时无法获取", detail: errorMessage };
  if (!snapshot?.primary && !snapshot?.secondary) {
    if (snapshot?.status === "signed_out") return { label: "尚未登录", detail: "请先在 Codex 中登录 ChatGPT" };
    if (snapshot?.status === "api_key_unsupported") return { label: "当前为 API Key 模式", detail: "订阅额度仅支持 ChatGPT 登录" };
    return { label: "暂无额度数据", detail: snapshot?.error || "Codex 未返回可用窗口" };
  }
  if (freshness === "expired") {
    return { label: "数据已过期", detail: `上次成功更新于 ${dataAgeMinutes(snapshot)} 分钟前` };
  }
  if (freshness === "reconnecting") {
    return {
      label: refreshing && !errorMessage ? "正在同步" : "正在重连",
      detail: `显示 ${dataAgeMinutes(snapshot)} 分钟前的数据`,
    };
  }
  if (snapshot?.status === "limit_reached") return { label: "额度已用尽", detail: "等待额度窗口重置" };
  return { label: "状态良好", detail: "实时用量已同步" };
}

function footerStatusCopy(freshness = dataFreshness()): string {
  if (freshness === "fresh") return "实时用量已同步";
  if (freshness === "reconnecting" && snapshot) {
    const action = refreshing && !errorMessage ? "正在同步" : "正在重连";
    return `${action} · 显示 ${dataAgeMinutes(snapshot)} 分钟前的数据`;
  }
  if (freshness === "expired" && snapshot) {
    return `数据已过期 · 上次成功更新于 ${dataAgeMinutes(snapshot)} 分钟前`;
  }
  return statusCopy(freshness).detail;
}

function scheduleFreshnessExpiry(): void {
  window.clearTimeout(freshnessExpiryTimer);
  if (!hasUsage(snapshot)) return;
  const remainingSeconds = STALE_AFTER_SECONDS - snapshotAgeSeconds(snapshot);
  if (remainingSeconds <= 0) return;
  freshnessExpiryTimer = window.setTimeout(() => {
    render();
    void updateTrayIcon(snapshot);
  }, remainingSeconds * 1000 + 50);
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

async function initializeAutostart(): Promise<void> {
  if (!isTauri) return;
  autostartLoading = true;
  autostartError = "";
  try {
    autostartEnabled = await isAutostartEnabled();
  } catch (error) {
    autostartError = error instanceof Error ? error.message : String(error);
  } finally {
    autostartLoading = false;
    render();
  }
}

async function initializeRuntimePlatform(): Promise<void> {
  if (!isTauri) return;
  try {
    const platform = await invoke<string>("runtime_platform");
    runtimePlatform = platform === "windows" || platform === "macos" ? platform : "other";
  } catch {
    runtimePlatform = "windows";
  }
}

async function setAutostart(enabled: boolean): Promise<void> {
  if (!isTauri || autostartLoading) return;
  autostartLoading = true;
  autostartError = "";
  render();
  try {
    if (enabled) await enableAutostart();
    else await disableAutostart();
    autostartEnabled = await isAutostartEnabled();
  } catch (error) {
    autostartError = error instanceof Error ? error.message : String(error);
    autostartEnabled = await isAutostartEnabled().catch(() => autostartEnabled);
  } finally {
    autostartLoading = false;
    render();
  }
}

function icon(name: "refresh" | "settings" | "exit" | "clock" | "check" | "alert" | "app" | "shield" | "close" | "moon" | "power"): string {
  const paths = {
    refresh: '<path d="M20 11a8.1 8.1 0 1 0 .1 4M20 4v7h-7"/>',
    settings: '<path d="M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4V21a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9A1.7 1.7 0 0 0 3 14H3v-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3A1.7 1.7 0 0 0 10 3V3h4v.1a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z"/>',
    exit: '<path d="M10 5H5v14h5M14 8l4 4-4 4M9 12h9"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>',
    check: '<circle cx="12" cy="12" r="8"/><path d="m8.5 12 2.2 2.2 4.8-5"/>',
    alert: '<path d="M12 3 2.8 19h18.4L12 3Z"/><path d="M12 9v4M12 16.5v.1"/>',
    app: '<defs><linearGradient id="meter-app-wave" x1="5" y1="7" x2="19" y2="17" gradientUnits="userSpaceOnUse"><stop stop-color="#7ff7d5"/><stop offset=".52" stop-color="#45e5c1"/><stop offset="1" stop-color="#1fc7a7"/></linearGradient></defs><path d="M5.45 12.55h4.15l1.82-4.72 2.62 8.72 1.8-4.55h3.9" fill="none" stroke="url(#meter-app-wave)" stroke-width="2.05" stroke-linecap="round" stroke-linejoin="round"/>',
    shield: '<defs><linearGradient id="meter-shield" x1="5" y1="3" x2="18" y2="21" gradientUnits="userSpaceOnUse"><stop stop-color="#78f0be"/><stop offset=".52" stop-color="#45dba1"/><stop offset="1" stop-color="#22b981"/></linearGradient></defs><path d="M12 2.25 19.35 5.2v5.7c0 4.55-2.83 8.3-7.35 10.3-4.52-2-7.35-5.75-7.35-10.3V5.2L12 2.25Z" fill="url(#meter-shield)" stroke="rgba(235,255,248,.9)" stroke-width="1.1" stroke-linejoin="round"/><path d="m8.55 11.85 2.2 2.2 4.8-4.95" fill="none" stroke="#fff" stroke-width="2.05" stroke-linecap="round" stroke-linejoin="round"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    moon: '<path d="M20 15.2A8 8 0 0 1 8.8 4 8 8 0 1 0 20 15.2Z"/>',
    power: '<path d="M12 3v9M6.3 6.3a8 8 0 1 0 11.4 0"/>',
  };
  return `<svg aria-hidden="true" viewBox="0 0 24 24">${paths[name]}</svg>`;
}

function renderWindowCard(item: LimitWindow): string {
  const remaining = remainingOf(item);
  return `
    <div class="window-card" data-tone="${usageTone(remaining)}">
      <div class="window-card-head">
        <span class="window-name">${formatWindow(item.windowDurationMins)}</span>
        <strong>${remaining}%</strong>
      </div>
      <div class="window-track" aria-hidden="true"><i style="width:${remaining}%"></i></div>
      <span class="reset-time">${formatReset(item.resetsAt)}</span>
    </div>`;
}

function renderResetCard(item: LimitWindow): string {
  return `
    <div class="window-card action-card" data-tone="${usageTone(remainingOf(item))}">
      <span class="action-icon">${icon("clock")}</span>
      <div>
        <strong>${formatReset(item.resetsAt)}</strong>
        <small>${formatWindow(item.windowDurationMins)} 窗口</small>
      </div>
    </div>`;
}

function renderUpdatedCard(fetchedAt: number): string {
  return `
    <div class="window-card action-card">
      <span class="action-icon">${icon("refresh")}</span>
      <div>
        <strong>${formatUpdated(fetchedAt)}</strong>
        <small>来自 Codex 官方服务</small>
      </div>
    </div>`;
}

function render(): void {
  const data = snapshot;
  const tightest = data ? tightestWindow(data) : null;
  const remaining = tightest ? remainingOf(tightest) : 0;
  const hasUsageData = Boolean(data && tightest);
  const reached = data?.status === "limit_reached";
  const freshness = dataFreshness();
  lastRenderedFreshness = freshness;
  scheduleFreshnessExpiry();
  const state = freshness === "loading"
    ? "loading"
    : freshness === "expired"
      ? "expired"
      : freshness === "reconnecting"
        ? "reconnecting"
        : !hasUsageData || reached
          ? "error"
          : "ok";
  const status = statusCopy(freshness);
  const windowCount = Number(Boolean(data?.primary)) + Number(Boolean(data?.secondary));
  const footerCopy = footerStatusCopy(freshness);
  const statusIcon = state === "ok" ? "shield" : state === "loading" ? "clock" : "alert";

  app.innerHTML = `
    <div class="panel-shell">
    <section class="glass-card main-card" data-state="${state}" aria-label="Codex 用量">
      <div class="shine" aria-hidden="true"></div>
      <header>
        <div class="brand-line">
          <span class="app-mark">${icon("app")}</span>
          <h1>Codex Meter</h1>
          ${!isTauri ? '<span class="mock-badge">演示数据</span>' : ""}
        </div>
        <div class="header-actions">
          <button class="icon-button header-refresh" data-action="refresh" aria-label="立即刷新" title="立即刷新" ${refreshing ? "disabled" : ""}>${icon("refresh")}</button>
          <button class="icon-button" data-action="settings" aria-label="偏好设置" title="偏好设置" aria-expanded="${settingsOpen}" aria-controls="settings-card">${icon("settings")}</button>
        </div>
      </header>
      <p class="status-line" role="status" aria-live="polite"><span class="status-icon">${icon(statusIcon)}</span><span>${status.label}</span></p>

      ${data && tightest ? `
        <div class="usage-hero" data-tone="${usageTone(remaining)}">
          <span class="hero-label">剩余用量</span>
          <div class="hero-meter" role="img" aria-label="最紧张窗口剩余 ${remaining}%">
            <strong>${remaining}<small>%</small></strong>
            <div class="hero-track" aria-hidden="true"><i style="width:${remaining}%"></i></div>
          </div>
          <p class="hero-meta">${data.planType ? `${formatPlan(data.planType)} 计划` : "当前账户"}${data.resetCreditsAvailable != null ? ` · 可重置 ${Math.max(0, Math.floor(data.resetCreditsAvailable))} 次` : ""}</p>
          <p class="usage-quip">${usageQuip(remaining)}</p>
        </div>
        <div class="window-grid" aria-label="用量窗口">
          ${windowCount === 1 && tightest ? renderResetCard(tightest) : data.primary ? renderWindowCard(data.primary) : ""}
          ${windowCount === 1 ? renderUpdatedCard(data.fetchedAt) : data.secondary ? renderWindowCard(data.secondary) : ""}
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
          <span>${footerCopy}</span>
        </div>
        <button class="icon-button exit" data-action="exit" aria-label="退出 Codex Meter" title="退出">${icon("exit")}</button>
      </footer>
    </section>
    ${settingsOpen ? `
      <div class="settings-stack">
      <span class="settings-connector" aria-hidden="true"></span>
      <section class="glass-card settings-card" id="settings-card" aria-label="偏好设置">
        <div class="shine" aria-hidden="true"></div>
        <div class="settings-header">
          <div><span class="settings-mark">${icon("settings")}</span><h2>偏好设置</h2></div>
          <button class="icon-button" data-action="settings" aria-label="关闭偏好设置" title="关闭">${icon("close")}</button>
        </div>
        <div class="settings-panel">
          <div class="setting-row"><span class="setting-label"><i>${icon("moon")}</i><span>界面主题</span></span><strong>跟随系统</strong></div>
          <div class="setting-row"><span class="setting-label"><i>${icon("clock")}</i><span>自动刷新</span></span><strong>每 1 分钟</strong></div>
          <label class="setting-row setting-toggle" for="autostart-toggle">
            <span class="setting-label"><i>${icon("power")}</i><span class="setting-copy"><span>随系统登录启动</span><small id="autostart-help">登录后自动驻留托盘</small></span></span>
            <input id="autostart-toggle" type="checkbox" data-setting="autostart" aria-describedby="autostart-help" ${autostartEnabled ? "checked" : ""} ${autostartLoading || !isTauri ? "disabled" : ""}>
            <span class="switch" aria-hidden="true"><i></i></span>
          </label>
        </div>
        ${autostartError ? `<p class="setting-note setting-error" role="status">设置失败：${autostartError}</p>` : `<p class="setting-note">${autostartLoading ? "正在读取系统启动设置…" : autostartEnabled ? "已加入系统登录项。" : "安装到固定位置后再开启。"}</p>`}
      </section>
      </div>` : ""}
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
  void updateTrayIcon(snapshot);
  try {
    const next = normalizeSnapshot(await invoke("refresh_usage"));
    const successful = Boolean(tightestWindow(next)) && !next.error && (next.status === "ok" || next.status === "limit_reached");
    if (successful) {
      snapshot = next;
      saveSnapshot(next);
    } else if (hasUsage(snapshot)) {
      errorMessage = next.error || statusCopyFor(next.status);
      snapshot = { ...snapshot, status: "stale" };
    } else {
      snapshot = next;
      errorMessage = next.error || "";
    }
  } catch (error) {
    errorMessage = error instanceof Error ? error.message : String(error);
    if (hasUsage(snapshot)) {
      snapshot = { ...snapshot, status: "stale" };
    }
  } finally {
    loading = false;
    refreshing = false;
    render();
    await updateTrayIcon(snapshot);
  }
}

interface TrayPresentation {
  mood: CatMood;
  remaining: number;
  color: string;
  alertDot: boolean;
  canShimmer: boolean;
  tooltip: string;
}

function trayPresentation(data: UsageSnapshot | null): TrayPresentation {
  const tightest = data ? tightestWindow(data) : null;
  const freshness = dataFreshness();
  if (!data || !tightest) {
    const unavailable = freshness === "unavailable";
    return {
      mood: "neutral",
      remaining: unavailable ? 0 : 28,
      color: "#7890aa",
      alertDot: unavailable,
      canShimmer: false,
      tooltip: unavailable ? "Codex 暂时无法获取用量" : "Codex 正在获取用量",
    };
  }

  const remaining = remainingOf(tightest);
  if (freshness === "expired") {
    return {
      mood: "sleeping",
      remaining,
      color: "#f2ae42",
      alertDot: true,
      canShimmer: false,
      tooltip: `Codex 数据已过期 · 剩余 ${remaining}%`,
    };
  }

  const exhausted = remaining === 0 && data.status === "limit_reached";
  const mood: CatMood = exhausted
    ? "exhausted"
    : remaining >= 50
      ? "healthy"
      : remaining >= 20
        ? "warning"
        : "critical";
  const prefix = freshness === "reconnecting" ? "Codex 正在重连" : "Codex";
  return {
    mood,
    remaining,
    color: usageColor(remaining),
    alertDot: false,
    canShimmer: runtimePlatform === "macos" && freshness === "fresh" && data.status === "ok" && !refreshing && remaining > 0,
    tooltip: `${prefix} · 剩余 ${remaining}%`,
  };
}

function roundedRectPath(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  const r = Math.min(radius, width / 2, height / 2);
  context.beginPath();
  context.moveTo(x + r, y);
  context.arcTo(x + width, y, x + width, y + height, r);
  context.arcTo(x + width, y + height, x, y + height, r);
  context.arcTo(x, y + height, x, y, r);
  context.arcTo(x, y, x + width, y, r);
  context.closePath();
}

function drawCatFace(context: CanvasRenderingContext2D, mood: CatMood): void {
  const accent = mood === "warning" || mood === "sleeping"
    ? "#f2c15a"
    : mood === "critical" || mood === "exhausted"
      ? "#ff7e8e"
      : mood === "neutral"
        ? "#8eb7ca"
        : "#63f1e5";
  const earTipY = mood === "healthy" ? 7 : mood === "warning" || mood === "sleeping" || mood === "neutral" ? 10 : 14;
  const drawEar = (points: Array<[number, number]>): void => {
    context.beginPath();
    context.moveTo(points[0][0], points[0][1]);
    for (const [x, y] of points.slice(1)) context.lineTo(x, y);
    context.closePath();
    context.fillStyle = "rgba(7, 30, 44, .98)";
    context.fill();
    context.strokeStyle = accent;
    context.lineWidth = 2.1;
    context.stroke();
  };

  context.lineJoin = "round";
  context.shadowColor = accent;
  context.shadowBlur = 3;
  if (mood === "critical" || mood === "exhausted") {
    drawEar([[18, 19], [10, earTipY], [13, 27]]);
    drawEar([[46, 19], [54, earTipY], [51, 27]]);
  } else {
    drawEar([[15, 21], [18, earTipY], [27, 18]]);
    drawEar([[37, 18], [46, earTipY], [49, 21]]);
  }

  const faceGradient = context.createLinearGradient(18, 15, 46, 40);
  faceGradient.addColorStop(0, "#153c50");
  faceGradient.addColorStop(.52, "#092739");
  faceGradient.addColorStop(1, "#041522");
  context.fillStyle = faceGradient;
  context.strokeStyle = accent;
  context.lineWidth = 2.1;
  roundedRectPath(context, 14, 15, 36, 27, 13);
  context.fill();
  context.stroke();
  context.shadowBlur = 0;

  context.strokeStyle = accent;
  context.fillStyle = accent;
  context.lineWidth = 2;
  context.lineCap = "round";
  if (mood === "sleeping" || mood === "exhausted") {
    context.beginPath();
    context.moveTo(22, 28);
    context.quadraticCurveTo(25, 30, 28, 28);
    context.moveTo(36, 28);
    context.quadraticCurveTo(39, 30, 42, 28);
    context.stroke();
  } else {
    for (const eyeX of [25, 39]) {
      const eyeGradient = context.createRadialGradient(eyeX - 1, 26, .6, eyeX, 28, 5);
      eyeGradient.addColorStop(0, "#f5ffff");
      eyeGradient.addColorStop(.22, "#9ffcf4");
      eyeGradient.addColorStop(.38, "#1db9b4");
      eyeGradient.addColorStop(.72, "#092c3e");
      eyeGradient.addColorStop(1, "#020c15");
      context.beginPath();
      context.ellipse(eyeX, 27.5, mood === "critical" ? 4.2 : 3.8, 4.8, 0, 0, Math.PI * 2);
      context.fillStyle = eyeGradient;
      context.fill();
      context.strokeStyle = accent;
      context.lineWidth = 1.1;
      context.stroke();
      context.beginPath();
      context.arc(eyeX - 1.1, 26, 1, 0, Math.PI * 2);
      context.fillStyle = "rgba(255, 255, 255, .95)";
      context.fill();
    }
  }

  context.fillStyle = "#f4ffff";
  context.beginPath();
  context.moveTo(30.5, 32.5);
  context.lineTo(33.5, 32.5);
  context.lineTo(32, 34);
  context.closePath();
  context.fill();
  context.strokeStyle = "#f4ffff";
  context.lineWidth = 1.7;
  context.beginPath();
  if (mood === "healthy") {
    context.moveTo(32, 34);
    context.quadraticCurveTo(29.5, 37, 27.5, 35);
    context.moveTo(32, 34);
    context.quadraticCurveTo(34.5, 37, 36.5, 35);
  } else if (mood === "critical" || mood === "exhausted") {
    context.moveTo(28.5, 37);
    context.quadraticCurveTo(32, 33.8, 35.5, 37);
  } else {
    context.moveTo(28.5, 35.5);
    context.quadraticCurveTo(32, 36.5, 35.5, 35.5);
  }
  context.stroke();
}

function drawTrayArtwork(context: CanvasRenderingContext2D, presentation: TrayPresentation, shimmerPosition?: number): void {
  const darkMode = themeQuery.matches;
  const isMacOS = runtimePlatform === "macos";
  const canvasWidth = isMacOS ? 112 : 64;
  const canvasHeight = isMacOS ? 48 : 64;
  const glassX = isMacOS ? 2 : 1;
  const glassY = isMacOS ? 2 : 1;
  const glassWidth = isMacOS ? 108 : 62;
  const glassHeight = isMacOS ? 44 : 62;
  context.clearRect(0, 0, canvasWidth, canvasHeight);

  const glass = context.createLinearGradient(glassX + 3, glassY, glassX + glassWidth - 3, glassY + glassHeight);
  glass.addColorStop(0, darkMode ? "rgba(31, 61, 81, .98)" : "rgba(36, 74, 96, .97)");
  glass.addColorStop(.52, darkMode ? "rgba(5, 17, 30, .99)" : "rgba(9, 28, 43, .99)");
  glass.addColorStop(1, darkMode ? "rgba(18, 39, 57, .98)" : "rgba(20, 47, 65, .98)");
  roundedRectPath(context, glassX, glassY, glassWidth, glassHeight, isMacOS ? 12 : 15);
  context.fillStyle = glass;
  context.fill();
  context.strokeStyle = darkMode ? "rgba(220, 245, 250, .68)" : "rgba(200, 239, 246, .82)";
  context.lineWidth = 1.4;
  context.stroke();

  const glassShine = context.createLinearGradient(glassX + 7, glassY + 2, glassX + glassWidth * .55, glassY + glassHeight * .65);
  glassShine.addColorStop(0, "rgba(255, 255, 255, .5)");
  glassShine.addColorStop(.45, "rgba(255, 255, 255, .09)");
  glassShine.addColorStop(1, "rgba(255, 255, 255, 0)");
  roundedRectPath(context, glassX + 2, glassY + 2, glassWidth - 4, glassHeight - 4, isMacOS ? 10 : 12);
  context.fillStyle = glassShine;
  context.fill();

  context.save();
  if (isMacOS) {
    context.translate(1, 3);
    context.scale(.88, .88);
  } else {
    context.translate(-11, -9);
    context.scale(1.35, 1.62);
  }
  drawCatFace(context, presentation.mood);
  context.restore();

  if (isMacOS) {
    roundedRectPath(context, 52, 17, 54, 14, 7);
    context.fillStyle = "rgba(1, 10, 20, .82)";
    context.fill();
    context.strokeStyle = "rgba(186, 219, 231, .3)";
    context.lineWidth = 1;
    context.stroke();

    const fillWidth = Math.max(0, 50 * presentation.remaining / 100);
    if (fillWidth > 0) {
      roundedRectPath(context, 54, 21, Math.max(3, fillWidth), 6, 3);
      const progress = context.createLinearGradient(54, 21, 104, 27);
      progress.addColorStop(0, presentation.color);
      progress.addColorStop(.65, presentation.color);
      progress.addColorStop(1, "#d7fff7");
      context.fillStyle = progress;
      context.fill();

      context.save();
      roundedRectPath(context, 54, 21, Math.max(3, fillWidth), 6, 3);
      context.clip();
      context.fillStyle = "rgba(255, 255, 255, .42)";
      context.fillRect(55, 21.5, Math.max(1, fillWidth - 2), 1.3);
      if (shimmerPosition !== undefined) {
        const shimmerX = 50 + (fillWidth + 12) * shimmerPosition;
        context.translate(shimmerX, 19);
        context.rotate(-.28);
        const shimmer = context.createLinearGradient(-5, 0, 5, 0);
        shimmer.addColorStop(0, "rgba(255, 255, 255, 0)");
        shimmer.addColorStop(.5, "rgba(255, 255, 255, .82)");
        shimmer.addColorStop(1, "rgba(255, 255, 255, 0)");
        context.fillStyle = shimmer;
        context.fillRect(-5, 0, 10, 12);
      }
      context.restore();
    }
  }

  if (presentation.alertDot) {
    const alertX = isMacOS ? 43 : 55;
    const alertY = isMacOS ? 8 : 8;
    context.save();
    context.beginPath();
    context.arc(alertX, alertY, 4.4, 0, Math.PI * 2);
    context.fillStyle = "rgba(4, 15, 26, .9)";
    context.fill();
    context.beginPath();
    context.arc(alertX, alertY, 3, 0, Math.PI * 2);
    context.fillStyle = "#f2ae42";
    context.fill();
    context.strokeStyle = "rgba(255, 238, 193, .9)";
    context.lineWidth = .8;
    context.stroke();
    context.restore();
  }
}

async function updateTrayIcon(data: UsageSnapshot | null, shimmerPosition?: number): Promise<void> {
  if (!isTauri) return;
  const width = runtimePlatform === "macos" ? 112 : 64;
  const height = runtimePlatform === "macos" ? 48 : 64;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return;
  const presentation = trayPresentation(data);
  drawTrayArtwork(context, presentation, shimmerPosition);
  const rgba = Array.from(context.getImageData(0, 0, width, height).data);
  try {
    await invoke("update_tray_icon", { rgba, width, height, tooltip: presentation.tooltip });
  } catch {
    // Older backends may not expose dynamic tray icons; usage UI remains functional.
  }
}

async function playTrayShimmer(): Promise<void> {
  const presentation = trayPresentation(snapshot);
  if (trayAnimationRunning || reducedMotionQuery.matches || !presentation.canShimmer) return;
  trayAnimationRunning = true;
  try {
    for (const position of [0, .28, .56, .84, 1]) {
      if (reducedMotionQuery.matches || !trayPresentation(snapshot).canShimmer) break;
      await updateTrayIcon(snapshot, position);
      await new Promise<void>((resolve) => window.setTimeout(resolve, 110));
    }
    await updateTrayIcon(snapshot);
  } finally {
    trayAnimationRunning = false;
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

app.addEventListener("change", (event) => {
  const input = (event.target as Element).closest<HTMLInputElement>('input[data-setting="autostart"]');
  if (input) void setAutostart(input.checked);
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
  void initializeAutostart();
  void initializeRuntimePlatform().then(() => refreshUsage());
} else {
  void updateTrayIcon(mockSnapshot);
}

window.setInterval(() => {
  const freshness = dataFreshness();
  if (freshness !== lastRenderedFreshness) {
    render();
    void updateTrayIcon(snapshot);
    return;
  }
  const updated = app.querySelector<HTMLElement>(".updated span");
  if (updated && !refreshing) {
    updated.textContent = footerStatusCopy(freshness);
  }
}, 30_000);

window.setInterval(() => void refreshUsage(), 60_000);
window.setInterval(() => void playTrayShimmer(), 12_000);

themeQuery.addEventListener("change", () => {
  void updateTrayIcon(snapshot);
});

reducedMotionQuery.addEventListener("change", () => {
  void updateTrayIcon(snapshot);
});
