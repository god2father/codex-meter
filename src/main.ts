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

type UsageSource = "codex" | "claude";
interface Monitoring { codex: boolean; claude: boolean }

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

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

interface TokenUsageBreakdown {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  reasoningOutputTokens: number;
  totalTokens: number;
}

interface TokenUsagePeriod extends TokenUsageBreakdown {
  startedAt: string | null;
  updatedAt: string;
  active: boolean;
}

interface TokenUsageSnapshot {
  recentTurn: TokenUsagePeriod | null;
  today: TokenUsageBreakdown;
  currentSession: TokenUsagePeriod | null;
  fetchedAt: number;
  sourceAvailable: boolean;
}

interface ClaudeTokenBreakdown {
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  totalTokens: number;
}

interface ClaudeUsageSnapshot {
  sourceAvailable: boolean;
  today: ClaudeTokenBreakdown;
  currentBlock: (ClaudeTokenBreakdown & { startedAt: number; resetsAt: number; messages: number }) | null;
  currentSession: (ClaudeTokenBreakdown & { updatedAt: number; model: string | null }) | null;
  models: Array<{ model: string; totalTokens: number; outputTokens: number }>;
  fetchedAt: number;
}

interface PanelPosition {
  anchorX: number;
  anchorY: number;
  edge: "top" | "bottom" | "left" | "right";
}

interface PanelResizeResult {
  constrained: boolean;
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

const mockTokenSnapshot: TokenUsageSnapshot = {
  recentTurn: {
    inputTokens: 15_260,
    cachedInputTokens: 11_800,
    outputTokens: 3_160,
    reasoningOutputTokens: 1_240,
    totalTokens: 18_420,
    startedAt: new Date(Date.now() - 95_000).toISOString(),
    updatedAt: new Date().toISOString(),
    active: false,
  },
  today: {
    inputTokens: 109_400,
    cachedInputTokens: 82_100,
    outputTokens: 17_400,
    reasoningOutputTokens: 6_800,
    totalTokens: 126_800,
  },
  currentSession: {
    inputTokens: 62_600,
    cachedInputTokens: 49_300,
    outputTokens: 11_750,
    reasoningOutputTokens: 4_900,
    totalTokens: 74_350,
    startedAt: null,
    updatedAt: new Date().toISOString(),
    active: false,
  },
  fetchedAt: Math.floor(Date.now() / 1000),
  sourceAvailable: true,
};

const mockClaudeSnapshot: ClaudeUsageSnapshot = {
  sourceAvailable: true,
  today: { inputTokens: 4_200, cacheCreationTokens: 310_000, cacheReadTokens: 2_480_000, outputTokens: 58_000, totalTokens: 2_852_200 },
  currentBlock: {
    inputTokens: 1_100, cacheCreationTokens: 96_000, cacheReadTokens: 820_000, outputTokens: 17_500, totalTokens: 934_600,
    startedAt: Math.floor(Date.now() / 1000) - 2 * 3600, resetsAt: Math.floor(Date.now() / 1000) + 3 * 3600, messages: 42,
  },
  currentSession: {
    inputTokens: 620, cacheCreationTokens: 48_000, cacheReadTokens: 410_000, outputTokens: 9_800, totalTokens: 468_420,
    updatedAt: Math.floor(Date.now() / 1000) - 40, model: "claude-opus-5-5",
  },
  models: [{ model: "claude-opus-5-5", totalTokens: 2_400_000, outputTokens: 50_000 }, { model: "claude-haiku-5-5", totalTokens: 452_200, outputTokens: 8_000 }],
  fetchedAt: Math.floor(Date.now() / 1000),
};

const CACHE_KEY = "codex-meter:last-usage";
const STALE_AFTER_SECONDS = 5 * 60;
const themeQuery = window.matchMedia("(prefers-color-scheme: dark)");
let snapshot: UsageSnapshot | null = isTauri ? loadCachedSnapshot() : mockSnapshot;
let tokenSnapshot: TokenUsageSnapshot | null = isTauri ? null : mockTokenSnapshot;
let runtimePlatform: RuntimePlatform = isTauri ? "other" : "windows";
let loading = isTauri && !snapshot;
let refreshing = false;
let tokenLoading = isTauri;
let tokenError = "";
let tokenDetailsOpen = false;
let claudeSnapshot: ClaudeUsageSnapshot | null = isTauri ? null : mockClaudeSnapshot;
let claudeDetailsOpen = false;
// Matches the backend default until monitoring_status answers; the browser preview shows both.
let monitoring: Monitoring = isTauri ? { codex: true, claude: false } : { codex: true, claude: true };
let monitoringBusy: UsageSource | null = null;
let monitoringError = "";
let lastView = "";
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
let freshnessExpiryTimer = 0;
let lastTrayKey = "";
let exitArmed = false;
let exitArmTimer = 0;

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

function formatTokenSummary(value: number): string {
  const normalized = Math.max(0, Math.round(value));
  if (normalized < 10_000) return new Intl.NumberFormat("zh-CN").format(normalized);
  const [scaled, unit] = normalized >= 100_000_000 ? [normalized / 100_000_000, "亿"] : [normalized / 10_000, "万"];
  const maximumFractionDigits = scaled >= 100 ? 0 : scaled >= 10 ? 1 : 2;
  return `${new Intl.NumberFormat("zh-CN", { maximumFractionDigits }).format(scaled)}${unit}`;
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
  return { label: "状态良好", detail: "Codex 额度已同步" };
}

function footerStatusCopy(freshness = dataFreshness()): string {
  if (!monitoring.codex) return monitoring.claude ? "仅监测 Claude Code" : "监测已全部关闭";
  if (freshness === "fresh" && snapshot) return `Codex 额度 · ${formatUpdated(snapshot.fetchedAt)}`;
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
    document.documentElement.dataset.nativeGlass = (await invoke<boolean>("native_glass")) ? "liquid" : "legacy";
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

function icon(name: "chevronRight" | "spark" | "refresh" | "settings" | "exit" | "clock" | "check" | "alert" | "app" | "shield" | "close" | "moon" | "power" | "tokens" | "device" | "link" | "arrow" | "back" | "chevron" | "laptop"): string {
  const paths = {
    device: '<rect x="6" y="2.5" width="12" height="19" rx="3"/><path d="M9 6h6M10 17h4"/>',
    link: '<path d="m10 13 4-4M8 16l-1 1a3.5 3.5 0 0 1-5-5l4-4a3.5 3.5 0 0 1 5 0M16 8l1-1a3.5 3.5 0 0 1 5 5l-4 4a3.5 3.5 0 0 1-5 0"/>',
    arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
    back: '<path d="m14 6-6 6 6 6"/>',
    chevron: '<path d="m8 10 4 4 4-4"/>',
    chevronRight: '<path d="m10 8 4 4-4 4"/>',
    spark: '<path d="M12 3.5v17M4.6 7.75l14.8 8.5M4.6 16.25l14.8-8.5"/>',
    laptop: '<rect x="4" y="4" width="16" height="12" rx="2"/><path d="M2 20h20M9 16l-1 4m7-4 1 4"/>',
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
    tokens: '<path d="M4 19h16M6 16V9M12 16V5M18 16v-4"/>',
  };
  return `<svg aria-hidden="true" viewBox="0 0 24 24">${paths[name]}</svg>`;
}

const SOURCE_LABEL: Record<UsageSource, string> = { codex: "Codex 额度监测", claude: "Claude 用量监测" };

function sourceSwitch(source: UsageSource): string {
  const busy = monitoringBusy === source;
  return `<label class="setting-toggle source-switch" title="${monitoring[source] ? "关闭" : "开启"}${SOURCE_LABEL[source]}"><input type="checkbox" data-monitor="${source}" aria-label="${SOURCE_LABEL[source]}" ${monitoring[source] ? "checked" : ""} ${busy ? "disabled" : ""}><span class="switch" aria-hidden="true"><i></i></span></label>`;
}

function renderMonitorOff(source: UsageSource): string {
  const [title, mark, copy] = source === "codex"
    ? ["Codex", icon("app"), "额度与 Token 监测已关闭，不会启动 Codex 后台服务。"]
    : ["Claude Code", icon("spark"), "开启后读取本机 Claude Code 记录中的 Token 数字，不读取对话内容。"];
  return `<section class="token-card monitor-off${source === "claude" ? " claude-card" : ""}" aria-label="${title} 监测已关闭">
    <div class="token-card-head">
      <div><span class="token-mark${source === "claude" ? " claude-mark" : ""}">${mark}</span><strong>${title}</strong></div>
      ${sourceSwitch(source)}
    </div>
    <p class="token-note">${copy}</p>
  </section>`;
}

function renderQuota(): string {
  const data = snapshot;
  const windows = [data?.primary, data?.secondary].filter(Boolean) as LimitWindow[];
  const status = statusCopy();
  return `<section class="quota-strip" aria-label="订阅剩余额度">
    <div class="section-caption"><span>Codex 剩余额度</span><span class="caption-end"><span>${data?.planType ? escapeHtml(formatPlan(data.planType)) : ""}${data?.resetCreditsAvailable != null ? ` · 可重置 ${Math.max(0, Math.floor(data.resetCreditsAvailable))} 次` : ""}</span>${sourceSwitch("codex")}</span></div>
    ${windows.length ? `<div class="quota-grid">${windows.map(item => {
      const value = remainingOf(item);
      return `<div class="quota-window" data-tone="${usageTone(value)}">
        <div class="quota-heading"><span>${formatWindow(item.windowDurationMins)}</span><strong>${value}<small>%</small></strong></div>
        <div class="quota-track" role="meter" aria-label="${formatWindow(item.windowDurationMins)}剩余" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${value}"><i style="width:${value}%"></i></div>
        <span class="reset-time">${formatReset(item.resetsAt)}</span>
      </div>`;
    }).join("")}</div>` : `<div class="quota-empty">${icon(loading ? "clock" : "alert")}<span>${escapeHtml(status.label)}</span><button class="text-button" data-action="refresh" ${refreshing ? "disabled" : ""}>重试</button></div>`}
  </section>`;
}

function renderSettings(): string {
  return `<section id="settings-card" class="settings-content" aria-label="偏好设置">
    <div class="section-caption"><span>通用</span></div>
    <div class="settings-group">
      <label class="setting-row setting-toggle"><span class="setting-label"><i>${icon("power")}</i><span class="setting-copy"><span>登录时启动</span><small>自动驻留托盘</small></span></span><input type="checkbox" data-setting="autostart" aria-label="登录时启动" ${autostartEnabled ? "checked" : ""} ${autostartLoading || !isTauri ? "disabled" : ""}><span class="switch" aria-hidden="true"><i></i></span></label>
    </div>
    ${autostartError ? `<p class="inline-error" role="alert">${escapeHtml(autostartError)}</p>` : ""}
    <p class="setting-note">外观跟随系统。Codex 额度在后台每分钟刷新，面板打开时每 30 秒；Token 统计每 10–30 秒。</p>
    <div class="section-caption settings-caption"><span>监测</span></div>
    <div class="settings-group">
      ${(["codex", "claude"] as UsageSource[]).map(source => `<label class="setting-row setting-toggle"><span class="setting-label"><i>${icon(source === "codex" ? "app" : "spark")}</i><span class="setting-copy"><span>${SOURCE_LABEL[source]}</span><small>${source === "codex" ? "订阅额度与本机 Codex Token" : "本机 ~/.claude 记录中的 Token"}</small></span></span><input type="checkbox" data-monitor="${source}" aria-label="${SOURCE_LABEL[source]}" ${monitoring[source] ? "checked" : ""} ${monitoringBusy === source ? "disabled" : ""}><span class="switch" aria-hidden="true"><i></i></span></label>`).join("")}
    </div>
    ${monitoringError ? `<p class="inline-error" role="alert">${escapeHtml(monitoringError)}</p>` : ""}
    <p class="settings-footnote">关闭的来源不再刷新，也不会占用后台资源；设置会在重启后保留。</p>
  </section>`;
}

function renderTokenValue(value: number | undefined, available: boolean): string {
  if (!available || value === undefined) return "—";
  return formatTokenSummary(value);
}

function renderTokenTableCell(value: number | undefined, available: boolean): string {
  if (!available || value === undefined) return '<td aria-label="暂无数据">—</td>';
  const formatted = formatTokenSummary(value);
  return `<td title="${formatted}">${formatted}</td>`;
}

/** One summary figure; the visible label is hidden from screen readers and folded into the value's label. */
function tokenStat(label: string, value: number | undefined, available: boolean, active = false): string {
  const text = renderTokenValue(value, available);
  const spoken = text === "—" ? "暂无数据" : text;
  return `<div class="token-stat">
    <span aria-hidden="true">${label}${active ? "<i></i>" : ""}</span>
    <strong aria-label="${label}${active ? "（进行中）" : ""} ${spoken}" title="${spoken}">${text}</strong>
  </div>`;
}

function renderTokenUsage(): string {
  const data = tokenSnapshot;
  const available = Boolean(data?.sourceAvailable);
  const recent = data?.recentTurn ?? null;
  const today = data?.today;
  const session = data?.currentSession ?? null;
  const stateCopy = tokenError
    ? "Token 统计暂时无法读取"
    : tokenLoading && !data
      ? "正在读取本机统计"
      : !available
        ? "尚未发现本机 Codex 会话记录"
        : recent?.active
          ? "最近一轮仍在进行"
          : "仅统计本机 Token，不读取对话内容";

  return `
    <section class="token-card" aria-label="Codex Token 用量">
      <div class="token-card-head">
        <div><span class="token-mark">${icon("tokens")}</span><strong>Codex Token</strong></div>
        <button class="token-detail-button" data-action="token-details" aria-expanded="${tokenDetailsOpen}" aria-controls="token-details">
          ${tokenDetailsOpen ? "收起" : "明细"}${icon("chevron")}
        </button>
      </div>
      <div class="token-summary-grid" role="group" aria-label="Codex Token 摘要">
        ${tokenStat("最近一轮", recent?.totalTokens, available, Boolean(recent?.active))}
        ${tokenStat("今日累计", today?.totalTokens, available)}
        ${tokenStat("当前会话", session?.totalTokens, available)}
      </div>
      ${tokenDetailsOpen ? `
        <div class="token-details" id="token-details">
          <table>
            <caption>Token 分类明细</caption>
            <thead><tr><th scope="col">分类</th><th scope="col">本轮</th><th scope="col">今日</th><th scope="col">会话</th></tr></thead>
            <tbody>
              <tr><th scope="row">输入</th>${renderTokenTableCell(recent?.inputTokens, available)}${renderTokenTableCell(today?.inputTokens, available)}${renderTokenTableCell(session?.inputTokens, available)}</tr>
              <tr><th scope="row">缓存</th>${renderTokenTableCell(recent?.cachedInputTokens, available)}${renderTokenTableCell(today?.cachedInputTokens, available)}${renderTokenTableCell(session?.cachedInputTokens, available)}</tr>
              <tr><th scope="row">输出</th>${renderTokenTableCell(recent?.outputTokens, available)}${renderTokenTableCell(today?.outputTokens, available)}${renderTokenTableCell(session?.outputTokens, available)}</tr>
              <tr><th scope="row">推理</th>${renderTokenTableCell(recent?.reasoningOutputTokens, available)}${renderTokenTableCell(today?.reasoningOutputTokens, available)}${renderTokenTableCell(session?.reasoningOutputTokens, available)}</tr>
              <tr class="token-total-row"><th scope="row">总计</th>${renderTokenTableCell(recent?.totalTokens, available)}${renderTokenTableCell(today?.totalTokens, available)}${renderTokenTableCell(session?.totalTokens, available)}</tr>
            </tbody>
          </table>
        </div>` : ""}
      <p class="token-note${tokenError ? " token-error" : ""}" role="${tokenError ? "status" : "note"}">${stateCopy}</p>
    </section>`;
}

function formatModel(model: string): string {
  return model.replace(/^claude-/, "").replace(/-(\d+)-(\d+)$/, " $1.$2").replace(/^./, c => c.toUpperCase());
}

function formatClaudeReset(unixSeconds: number): string {
  const minutes = Math.max(0, Math.round((unixSeconds - Date.now() / 1000) / 60));
  const time = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(unixSeconds * 1000));
  return minutes >= 60 ? `${time} 重置 · 剩 ${Math.floor(minutes / 60)} 时 ${minutes % 60} 分` : `${time} 重置 · 剩 ${minutes} 分`;
}

function renderClaudeUsage(): string {
  const data = claudeSnapshot;
  if (!monitoring.claude) return renderMonitorOff("claude");
  if (isTauri && data && !data.sourceAvailable) {
    return `<section class="token-card claude-card" aria-label="Claude 用量">
      <div class="token-card-head"><div><span class="token-mark claude-mark">${icon("spark")}</span><strong>Claude Code</strong></div>${sourceSwitch("claude")}</div>
      <p class="token-note">尚未发现本机 Claude Code 记录</p>
    </section>`;
  }
  const available = Boolean(data?.sourceAvailable);
  const block = data?.currentBlock ?? null;
  const session = data?.currentSession ?? null;
  const today = data?.today;
  const blockProgress = block ? clampPercent(((Date.now() / 1000) - block.startedAt) / (block.resetsAt - block.startedAt) * 100) : 0;
  // Cache reads dominate Claude totals (often >95%), so the headline counts input + output only.
  const io = (value: ClaudeTokenBreakdown | null | undefined) => value ? value.inputTokens + value.outputTokens : undefined;
  const note = !data
    ? "正在读取本机 Claude Code 记录"
    : block
      ? `${formatClaudeReset(block.resetsAt)} · 不含缓存`
      : "当前没有活跃的 5 小时窗口 · 数字不含缓存";
  const row = (label: string, key: keyof ClaudeTokenBreakdown) =>
    `<tr${key === "totalTokens" ? ' class="token-total-row"' : ""}><th scope="row">${label}</th>${renderTokenTableCell(block?.[key], available && Boolean(block))}${renderTokenTableCell(today?.[key], available)}${renderTokenTableCell(session?.[key], available && Boolean(session))}</tr>`;
  return `
    <section class="token-card claude-card" aria-label="Claude 用量">
      <div class="token-card-head">
        <div><span class="token-mark claude-mark">${icon("spark")}</span><strong>Claude Code</strong></div>
        <span class="caption-end"><button class="token-detail-button" data-action="claude-details" aria-expanded="${claudeDetailsOpen}" aria-controls="claude-details">
          ${claudeDetailsOpen ? "收起" : "明细"}${icon("chevron")}
        </button>${sourceSwitch("claude")}</span>
      </div>
      <div class="token-summary-grid" role="group" aria-label="Claude 用量摘要（输入加输出）">
        ${tokenStat("5 小时窗口", io(block), available && Boolean(block), Boolean(block))}
        ${tokenStat("今日累计", io(today), available)}
        ${tokenStat("当前会话", io(session), available && Boolean(session))}
      </div>
      ${block ? `<div class="quota-track claude-window" role="progressbar" aria-label="5 小时窗口已过时间" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${blockProgress}"><i style="width:${blockProgress}%"></i></div>` : ""}
      ${claudeDetailsOpen ? `
        <div class="token-details" id="claude-details">
          <table>
            <caption>Claude Token 分类明细</caption>
            <thead><tr><th scope="col">分类</th><th scope="col">5 小时</th><th scope="col">今日</th><th scope="col">会话</th></tr></thead>
            <tbody>${row("输入", "inputTokens")}${row("缓存写", "cacheCreationTokens")}${row("缓存读", "cacheReadTokens")}${row("输出", "outputTokens")}${row("总计", "totalTokens")}</tbody>
          </table>
          ${data?.models.length ? `<p class="claude-models">今日模型 · ${data.models.map(item => `${escapeHtml(formatModel(item.model))} ${formatTokenSummary(item.totalTokens)}`).join(" · ")}</p>` : ""}
        </div>` : ""}
      <p class="token-note" role="note">${note}</p>
    </section>`;
}

function render(): void {
  const freshness = dataFreshness();
  const state = !monitoring.codex ? "paused" : freshness === "fresh" ? snapshot?.status === "limit_reached" ? "error" : "ok" : freshness;
  const view = settingsOpen ? "settings" : "home";
  const changedView = view !== lastView;
  lastView = view;
  lastRenderedFreshness = freshness;
  scheduleFreshnessExpiry();
  const focused = document.activeElement instanceof HTMLInputElement ? document.activeElement : null;
  const focusId = focused?.id;
  const selection = focused ? [focused.selectionStart, focused.selectionEnd] : null;
  const scrollTop = app.querySelector<HTMLElement>(".panel-scroll")?.scrollTop ?? 0;
  app.innerHTML = `<div class="panel-shell">
    <section class="glass-card main-card" data-state="${state}" data-view="${view}" aria-label="Codex Meter">
      <header class="panel-header">
        <div class="brand-line">${settingsOpen ? `<button class="icon-button back-button" data-action="settings" aria-label="返回主页">${icon("back")}</button>` : `<span class="app-mark">${icon("app")}</span>`}<div><h1>${settingsOpen ? "偏好设置" : "Codex Meter"}</h1><span class="brand-subtitle">${settingsOpen ? "你的桌面，按你的习惯" : "Codex · Claude 用量"}</span></div></div>
        <div class="header-actions">${!isTauri ? '<span class="mock-badge">预览</span>' : ""}${!settingsOpen ? `<button class="icon-button header-refresh" data-action="refresh" aria-label="刷新用量" title="刷新用量" aria-busy="${refreshing}" ${refreshing ? "disabled" : ""}>${icon("refresh")}</button><button class="icon-button settings-button" data-action="settings" aria-label="偏好设置" title="偏好设置" aria-expanded="false">${icon("settings")}</button>` : ""}</div>
      </header>
      <div class="panel-scroll${changedView ? " view-enter" : ""}">
        ${settingsOpen ? renderSettings() : `${monitoring.codex ? `${renderQuota()}${renderTokenUsage()}` : renderMonitorOff("codex")}${renderClaudeUsage()}`}
      </div>
      <footer class="panel-footer"><div class="updated" role="status" title="${escapeHtml(statusCopy().detail)}">${icon(state === "ok" ? "check" : state === "loading" ? "clock" : state === "paused" ? "power" : "alert")}<span>${escapeHtml(footerStatusCopy())}</span></div>${exitArmed ? `<button class="text-button exit-confirm" data-action="exit" aria-label="再次点击确认退出 Codex Meter">确认退出</button>` : `<button class="icon-button exit" data-action="exit" aria-label="退出 Codex Meter" title="退出 Codex Meter">${icon("exit")}</button>`}</footer>
    </section><span class="bubble-tail" aria-hidden="true"></span>
  </div>`;
  if (!changedView) {
    const scroller = app.querySelector<HTMLElement>(".panel-scroll");
    if (scroller) scroller.scrollTop = scrollTop;
  }
  if (focusId) {
    const input = document.getElementById(focusId) as HTMLInputElement | null;
    input?.focus({ preventScroll: true });
    if (selection && selection[0] !== null && selection[1] !== null) input?.setSelectionRange(selection[0], selection[1]);
  }
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
    const scroll = shell.querySelector<HTMLElement>(".panel-scroll");
    const hiddenContent = scroll ? Math.max(0, Math.min(scroll.scrollHeight, 600) - scroll.clientHeight) : 0;
    const height = Math.ceil(shell.offsetHeight + hiddenContent + parseFloat(bodyStyle.paddingTop) + parseFloat(bodyStyle.paddingBottom));
    applyPanelPosition();
    const nextSize = `${width}x${height}`;
    if (nextSize === lastPanelSize) return;
    lastPanelSize = nextSize;
    void invoke<PanelResizeResult>("resize_panel", { width, height })
      .then(({ constrained }) => {
        document.documentElement.dataset.panelConstrained = String(constrained);
      })
      .catch((error) => {
        lastPanelSize = "";
        console.error("无法调整用量面板尺寸", error);
      });
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

function normalizeTokenSnapshot(value: unknown): TokenUsageSnapshot {
  if (!value || typeof value !== "object") throw new Error("Codex 返回了无效 Token 数据");
  const candidate = value as TokenUsageSnapshot;
  const periods = [candidate.recentTurn, candidate.today, candidate.currentSession].filter(Boolean) as TokenUsageBreakdown[];
  if (periods.some((item) => typeof item.totalTokens !== "number" || typeof item.inputTokens !== "number")) {
    throw new Error("Token 用量数据不完整");
  }
  return candidate;
}

function applyTokenSnapshot(value: unknown): void {
  try {
    tokenSnapshot = normalizeTokenSnapshot(value);
    tokenError = "";
  } catch (error) {
    tokenError = error instanceof Error ? error.message : String(error);
  }
  tokenLoading = false;
  render();
}

/** Asks the background scheduler for fresh local token stats (and quota when asked). */
async function requestBackgroundRefresh(includeQuota: boolean): Promise<void> {
  if (!isTauri) {
    tokenSnapshot = { ...mockTokenSnapshot, fetchedAt: Math.floor(Date.now() / 1000) };
    claudeSnapshot = { ...mockClaudeSnapshot, fetchedAt: Math.floor(Date.now() / 1000) };
    tokenError = "";
    render();
    return;
  }
  await invoke("request_usage_refresh", {
    timezoneOffsetMinutes: new Date().getTimezoneOffset(),
    includeQuota,
  }).catch(() => undefined);
}

async function refreshAllUsage(): Promise<void> {
  await Promise.all([monitoring.codex ? refreshUsage() : Promise.resolve(), requestBackgroundRefresh(false)]);
}

async function loadMonitoring(): Promise<void> {
  if (!isTauri) return;
  try {
    monitoring = await invoke<Monitoring>("monitoring_status");
  } catch {
    // Keep defaults; the backend applies the same ones.
  }
  render();
  void updateTrayIcon(snapshot);
}

async function setMonitoring(source: UsageSource, enabled: boolean): Promise<void> {
  if (monitoringBusy) return;
  if (!isTauri) {
    // Browser preview has no backend; flip locally so both states can be inspected.
    monitoring = { ...monitoring, [source]: enabled };
    render();
    return;
  }
  monitoringBusy = source;
  monitoringError = "";
  render();
  try {
    monitoring = await invoke<Monitoring>("set_monitoring", { source, enabled });
    if (source === "codex" && enabled) {
      loading = !hasUsage(snapshot);
      tokenLoading = !tokenSnapshot;
    }
    if (source === "claude" && !enabled) claudeSnapshot = null;
    if (source === "codex" && !enabled) errorMessage = "";
  } catch (error) {
    monitoringError = error instanceof Error ? error.message : String(error);
  } finally {
    monitoringBusy = null;
    render();
    app.querySelector<HTMLInputElement>(`input[data-monitor="${source}"]`)?.focus();
    void updateTrayIcon(snapshot);
  }
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
    applyCodexSnapshot(normalizeSnapshot(await invoke("refresh_usage")));
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

function applyCodexSnapshot(next: UsageSnapshot): void {
  const successful = Boolean(tightestWindow(next)) && !next.error && (next.status === "ok" || next.status === "limit_reached");
  if (successful) {
    snapshot = next;
    errorMessage = "";
    saveSnapshot(next);
  } else if (hasUsage(snapshot)) {
    errorMessage = next.error || statusCopyFor(next.status);
    snapshot = { ...snapshot, status: "stale" };
  } else {
    snapshot = next;
    errorMessage = next.error || "";
  }
}

function claudeTooltip(): string {
  const data = claudeSnapshot;
  if (!monitoring.claude || !data?.sourceAvailable) return "";
  const value = data.currentBlock ?? data.today;
  const block = `${data.currentBlock ? "5 小时" : "今日"} ${formatTokenSummary(value.inputTokens + value.outputTokens)}`;
  return `\nClaude · ${block}`;
}

interface TrayPresentation {
  mood: CatMood;
  remaining: number;
  color: string;
  alertDot: boolean;
  title: string;
  tooltip: string;
}

function trayPresentation(data: UsageSnapshot | null): TrayPresentation {
  if (!monitoring.codex) {
    return { mood: "sleeping", remaining: 0, color: "#7890aa", alertDot: false, title: "—", tooltip: "Codex 额度监测已关闭" };
  }
  const tightest = data ? tightestWindow(data) : null;
  const freshness = dataFreshness();
  if (!data || !tightest) {
    const unavailable = freshness === "unavailable";
    return {
      mood: "neutral",
      remaining: unavailable ? 0 : 28,
      color: "#7890aa",
      alertDot: unavailable,
      title: unavailable ? "—" : "…",
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
      title: `${remaining}%`,
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
    title: `${remaining}%`,
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
  const drawEar = (points: Array<[number, number]>, inner: Array<[number, number]>): void => {
    context.beginPath();
    context.moveTo(points[0][0], points[0][1]);
    for (const [x, y] of points.slice(1)) context.lineTo(x, y);
    context.closePath();
    context.fillStyle = "#ae8257";
    context.fill();
    context.strokeStyle = "#3f2c22";
    context.lineWidth = 1.4;
    context.stroke();

    context.beginPath();
    context.moveTo(inner[0][0], inner[0][1]);
    for (const [x, y] of inner.slice(1)) context.lineTo(x, y);
    context.closePath();
    context.fillStyle = "#efaaa4";
    context.fill();
  };

  context.lineJoin = "round";
  drawEar([[11, 22], [15, 3], [29, 18]], [[15, 17], [17, 7], [24, 17]]);
  drawEar([[35, 18], [49, 3], [53, 22]], [[40, 17], [47, 7], [49, 17]]);

  const faceGradient = context.createLinearGradient(12, 14, 52, 46);
  faceGradient.addColorStop(0, "#c39a68");
  faceGradient.addColorStop(.48, "#a8764e");
  faceGradient.addColorStop(1, "#7e563d");
  context.beginPath();
  context.ellipse(32, 29, 21.5, 16.5, 0, 0, Math.PI * 2);
  context.fillStyle = faceGradient;
  context.fill();
  context.strokeStyle = "#3f2c22";
  context.lineWidth = 1.3;
  context.stroke();

  context.strokeStyle = "rgba(67, 42, 28, .95)";
  context.lineWidth = 2.7;
  context.lineCap = "round";
  context.beginPath();
  context.moveTo(24, 14);
  context.lineTo(27.5, 22);
  context.moveTo(32, 12.5);
  context.lineTo(32, 22.5);
  context.moveTo(40, 14);
  context.lineTo(36.5, 22);
  context.moveTo(13.5, 24);
  context.lineTo(20, 27);
  context.moveTo(12.5, 30);
  context.lineTo(19, 31.5);
  context.moveTo(50.5, 24);
  context.lineTo(44, 27);
  context.moveTo(51.5, 30);
  context.lineTo(45, 31.5);
  context.stroke();

  context.fillStyle = "#f7e7dc";
  context.beginPath();
  context.moveTo(28.5, 17);
  context.bezierCurveTo(30, 21, 29, 27, 30.5, 31.5);
  context.lineTo(33.5, 31.5);
  context.bezierCurveTo(35, 27, 34, 21, 35.5, 17);
  context.quadraticCurveTo(32, 19, 28.5, 17);
  context.fill();
  context.beginPath();
  context.ellipse(25.5, 35, 9.5, 7, -.1, 0, Math.PI * 2);
  context.ellipse(38.5, 35, 9.5, 7, .1, 0, Math.PI * 2);
  context.fill();

  const drawEye = (centerX: number): void => {
    context.beginPath();
    context.ellipse(centerX, 26.5, 6.6, 6.2, 0, 0, Math.PI * 2);
    context.fillStyle = "#2d201a";
    context.fill();
    context.beginPath();
    context.ellipse(centerX, 26.5, 5.1, 4.9, 0, 0, Math.PI * 2);
    const iris = context.createRadialGradient(centerX - 1.5, 24, .6, centerX, 26.5, 5.5);
    iris.addColorStop(0, "#ffd77a");
    iris.addColorStop(.65, "#e79b22");
    iris.addColorStop(1, "#9a5513");
    context.fillStyle = iris;
    context.fill();
    context.beginPath();
    context.ellipse(centerX, 27, 1.8, 3.5, 0, 0, Math.PI * 2);
    context.fillStyle = "#201813";
    context.fill();
    context.beginPath();
    context.arc(centerX - 1.7, 24.4, 1.2, 0, Math.PI * 2);
    context.fillStyle = "rgba(255, 252, 235, .92)";
    context.fill();
  };

  if (mood === "sleeping" || mood === "exhausted") {
    context.strokeStyle = "#3a2920";
    context.lineWidth = 2.2;
    context.beginPath();
    context.moveTo(16.5, 27);
    context.quadraticCurveTo(23, 31, 29.5, 27);
    context.moveTo(34.5, 27);
    context.quadraticCurveTo(41, 31, 47.5, 27);
    context.stroke();
  } else {
    drawEye(23);
    drawEye(41);
  }

  context.fillStyle = "#e69b9b";
  context.beginPath();
  context.moveTo(28.8, 33.5);
  context.quadraticCurveTo(32, 31.4, 35.2, 33.5);
  context.lineTo(32, 36.3);
  context.closePath();
  context.fill();

  context.strokeStyle = "#493229";
  context.lineWidth = 1.25;
  context.beginPath();
  context.moveTo(32, 35.5);
  context.lineTo(32, 38.5);
  context.moveTo(32, 38.5);
  context.quadraticCurveTo(29, 37, 27, 39.5);
  context.moveTo(32, 38.5);
  context.quadraticCurveTo(35, 37, 37, 39.5);
  context.stroke();

  context.strokeStyle = "rgba(255, 244, 229, .9)";
  context.lineWidth = .8;
  context.beginPath();
  context.moveTo(25, 35);
  context.lineTo(10, 32);
  context.moveTo(25, 37);
  context.lineTo(8, 38);
  context.moveTo(39, 35);
  context.lineTo(54, 32);
  context.moveTo(39, 37);
  context.lineTo(56, 38);
  context.stroke();
}

function statusCatImage(mood: CatMood): string {
  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const context = canvas.getContext("2d");
  if (!context) return "";
  context.translate(-6, 6);
  context.scale(1.25, 1.25);
  drawCatFace(context, mood);
  return canvas.toDataURL("image/png");
}

function drawTrayArtwork(context: CanvasRenderingContext2D, presentation: TrayPresentation): void {
  const darkMode = themeQuery.matches;
  const isMacOS = runtimePlatform === "macos";
  const canvasWidth = isMacOS ? 104 : 64;
  const canvasHeight = isMacOS ? 48 : 64;
  context.clearRect(0, 0, canvasWidth, canvasHeight);

  if (!isMacOS) {
    const glass = context.createLinearGradient(4, 1, 60, 63);
    glass.addColorStop(0, darkMode ? "rgba(31, 61, 81, .98)" : "rgba(36, 74, 96, .97)");
    glass.addColorStop(.52, darkMode ? "rgba(5, 17, 30, .99)" : "rgba(9, 28, 43, .99)");
    glass.addColorStop(1, darkMode ? "rgba(18, 39, 57, .98)" : "rgba(20, 47, 65, .98)");
    roundedRectPath(context, 1, 1, 62, 62, 15);
    context.fillStyle = glass;
    context.fill();
    context.strokeStyle = darkMode ? "rgba(220, 245, 250, .68)" : "rgba(200, 239, 246, .82)";
    context.lineWidth = 1.4;
    context.stroke();

    const glassShine = context.createLinearGradient(8, 3, 35, 41);
    glassShine.addColorStop(0, "rgba(255, 255, 255, .5)");
    glassShine.addColorStop(.45, "rgba(255, 255, 255, .09)");
    glassShine.addColorStop(1, "rgba(255, 255, 255, 0)");
    roundedRectPath(context, 3, 3, 58, 58, 12);
    context.fillStyle = glassShine;
    context.fill();
  }

  context.save();
  if (isMacOS) {
    context.translate(-1, 2);
    context.scale(.92, .92);
  } else {
    context.translate(-11, -9);
    context.scale(1.35, 1.62);
  }
  drawCatFace(context, presentation.mood);
  context.restore();

  if (isMacOS) {
    context.save();
    context.font = '600 22px -apple-system, BlinkMacSystemFont, "SF Pro Text", sans-serif';
    context.textAlign = "center";
    context.textBaseline = "middle";
    context.fillStyle = darkMode ? "rgba(239, 252, 255, .96)" : "rgba(13, 36, 52, .96)";
    context.shadowColor = presentation.color;
    context.shadowBlur = 1.5;
    context.fillText(presentation.title, 78, 15);
    context.restore();

    roundedRectPath(context, 54, 37, 48, 9, 4.5);
    context.fillStyle = darkMode ? "rgba(231, 248, 255, .18)" : "rgba(10, 31, 47, .18)";
    context.fill();

    const fillWidth = 44 * presentation.remaining / 100;
    if (fillWidth > 0) {
      roundedRectPath(context, 56, 39, Math.max(3, fillWidth), 5, 2.5);
      const progress = context.createLinearGradient(56, 41.5, 100, 41.5);
      progress.addColorStop(0, presentation.color);
      progress.addColorStop(.7, presentation.color);
      progress.addColorStop(1, "#d7fff7");
      context.fillStyle = progress;
      context.fill();
    }
  }

  if (presentation.alertDot) {
    const alertX = isMacOS ? 39 : 55;
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

async function updateTrayIcon(data: UsageSnapshot | null): Promise<void> {
  if (!isTauri) return;
  const width = runtimePlatform === "macos" ? 104 : 64;
  const height = runtimePlatform === "macos" ? 48 : 64;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  if (!context) return;
  const presentation = trayPresentation(data);
  const tooltip = presentation.tooltip + claudeTooltip();
  // Background events arrive every few seconds; skip the IPC when nothing visible changed.
  const trayKey = JSON.stringify([presentation, tooltip, themeQuery.matches, runtimePlatform]);
  if (trayKey === lastTrayKey) return;
  drawTrayArtwork(context, presentation);
  const rgba = Array.from(context.getImageData(0, 0, width, height).data);
  try {
    await invoke("update_tray_icon", {
      rgba,
      width,
      height,
      title: runtimePlatform === "macos" ? "" : null,
      tooltip,
    });
    lastTrayKey = trayKey;
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
      await refreshAllUsage();
      break;
    case "claude-details":
      claudeDetailsOpen = !claudeDetailsOpen;
      render();
      app.querySelector<HTMLButtonElement>('[data-action="claude-details"]')?.focus();
      break;
    case "token-details":
      tokenDetailsOpen = !tokenDetailsOpen;
      render();
      app.querySelector<HTMLButtonElement>('[data-action="token-details"]')?.focus();
      break;
    case "settings":
      settingsOpen = !settingsOpen;
      render();
      app.querySelector<HTMLButtonElement>('[data-action="settings"]')?.focus();

      break;
    case "exit":
      // Quitting removes the tray icon, so require a second click within a few seconds.
      if (!exitArmed) {
        exitArmed = true;
        render();
        app.querySelector<HTMLButtonElement>('[data-action="exit"]')?.focus();
        window.clearTimeout(exitArmTimer);
        exitArmTimer = window.setTimeout(() => { exitArmed = false; render(); }, 3000);
        break;
      }
      if (isTauri) await invoke("quit_app");
      else window.close();
      break;
  }
});

app.addEventListener("change", (event) => {
  const monitor = (event.target as Element).closest<HTMLInputElement>("input[data-monitor]");
  if (monitor) void setMonitoring(monitor.dataset.monitor as UsageSource, monitor.checked);
  const input = (event.target as Element).closest<HTMLInputElement>('input[data-setting="autostart"]');
  if (input) void setAutostart(input.checked);
});

render();

if (isTauri) {
  void loadMonitoring();
  document.addEventListener("contextmenu", (event) => event.preventDefault());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") void invoke("hide_panel").catch(() => undefined);
  });
  // The Rust scheduler owns the refresh cadence so updates keep flowing while the panel is hidden.
  void listen<UsageSnapshot>("usage://codex", ({ payload }) => {
    if (refreshing || !monitoring.codex) return;
    try {
      applyCodexSnapshot(normalizeSnapshot(payload));
    } catch (error) {
      errorMessage = error instanceof Error ? error.message : String(error);
    }
    loading = false;
    render();
    void updateTrayIcon(snapshot);
  });
  void listen("usage://tokens", ({ payload }) => applyTokenSnapshot(payload));
  void listen<string>("usage://tokens-error", ({ payload }) => {
    tokenError = payload;
    tokenLoading = false;
    render();
  });
  void listen<ClaudeUsageSnapshot>("usage://claude", ({ payload }) => {
    if (!monitoring.claude) return;
    const hadClaude = Boolean(claudeSnapshot?.sourceAvailable);
    claudeSnapshot = payload;
    render();
    if (hadClaude !== payload.sourceAvailable || payload.sourceAvailable) void updateTrayIcon(snapshot);
  });
  void listen("settings://open", () => {
    settingsOpen = true;
    render();
  });
  void listen<PanelPosition>("panel://positioned", ({ payload }) => {
    panelPosition = payload;
    applyPanelPosition();
  });
  void initializeAutostart();
  // The scheduler fetches quota on its first tick; only make sure local stats use our timezone.
  void initializeRuntimePlatform().then(() => requestBackgroundRefresh(false));
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


themeQuery.addEventListener("change", () => {
  void updateTrayIcon(snapshot);
});
