import { invoke } from "@tauri-apps/api/core";
import { getVersion } from "@tauri-apps/api/app";
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

type UsageSource = "codex" | "claude" | "claudeQuota";
interface Monitoring { codex: boolean; claude: boolean; claudeQuota: boolean }

interface ClaudeQuotaWindow { usedPercent: number; remainingPercent: number; resetsAt: number | null }
interface ClaudeQuotaSnapshot {
  status: "ok" | "no_credentials" | "expired" | "unauthorized" | "rate_limited" | "error";
  plan: string | null;
  fiveHour: ClaudeQuotaWindow | null;
  sevenDay: ClaudeQuotaWindow | null;
  sevenDayOpus: ClaudeQuotaWindow | null;
  sevenDaySonnet: ClaudeQuotaWindow | null;
  fetchedAt: number;
  message: string | null;
  /** Front-end only: windows are from an earlier successful read. */
  stale?: boolean;
}

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
const TRAY_SOURCE_KEY = "codex-meter:tray-source";
type TraySource = "codex" | "claude";
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
let claudeQuota: ClaudeQuotaSnapshot | null = isTauri ? null : {
  status: "ok", plan: "max", fetchedAt: Math.floor(Date.now() / 1000), message: null, sevenDaySonnet: null,
  fiveHour: { usedPercent: 38, remainingPercent: 62, resetsAt: Math.floor(Date.now() / 1000) + 3 * 3600 },
  sevenDay: { usedPercent: 81, remainingPercent: 19, resetsAt: Math.floor(Date.now() / 1000) + 2.5 * 86400 },
  sevenDayOpus: { usedPercent: 44, remainingPercent: 56, resetsAt: Math.floor(Date.now() / 1000) + 2.5 * 86400 },
};
let claudeDetailsOpen = false;
/** Set for the one render that opens a details table, so background refreshes do not replay its fade-in. */
let detailsEntering: "token" | "claude" | null = null;
// Matches the backend default until monitoring_status answers; the browser preview shows both.
let monitoring: Monitoring = isTauri ? { codex: true, claude: false, claudeQuota: false } : { codex: true, claude: true, claudeQuota: true };
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
let trayPreference: TraySource = loadTrayPreference();
let exitArmed = false;
let appVersion = "";
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
    max: "Max",
    team: "Team",
    business: "Business",
    enterprise: "Enterprise",
    edu: "Edu",
  };
  return knownPlans[plan.toLowerCase()] ?? plan;
}

const clockTime = new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });

/** Countdown inside a day, weekday inside a week, date beyond that. */
function formatReset(unixSeconds: number | null): string {
  if (unixSeconds === null) return "重置时间未知";
  const minutes = Math.round((unixSeconds - Date.now() / 1000) / 60);
  if (minutes <= 0) return "即将重置";
  if (minutes < 60) return `${minutes} 分钟后重置`;
  if (minutes < 24 * 60) {
    const rest = minutes % 60;
    return rest ? `${Math.floor(minutes / 60)} 小时 ${rest} 分后重置` : `${minutes / 60} 小时后重置`;
  }
  const date = new Date(unixSeconds * 1000);
  if (minutes < 7 * 24 * 60) {
    return `${new Intl.DateTimeFormat("zh-CN", { weekday: "short" }).format(date)} ${clockTime.format(date)} 重置`;
  }
  return `${date.getMonth() + 1}/${date.getDate()} ${clockTime.format(date)} 重置`;
}

/** Exact reset moment for the tooltip behind the relative text. */
function formatResetExact(unixSeconds: number | null): string {
  if (unixSeconds === null) return "";
  const date = new Date(unixSeconds * 1000);
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 ${clockTime.format(date)} 重置`;
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

/** Ring colour; the darker set keeps 3:1 against a light macOS menu bar. */
function usageColor(remaining: number, lightSurface = false): string {
  if (usageTone(remaining) === "warning") return lightSurface ? "#b9730f" : "#f2ae42";
  if (usageTone(remaining) === "critical") return lightSurface ? "#c93a4b" : "#f16676";
  return lightSurface ? "#0f8c6c" : "#39d7bc";
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
  if (freshness === "fresh" && snapshot) return snapshot.status === "limit_reached" ? "Codex 额度已用尽，等待重置" : "";
  if (freshness === "reconnecting" && snapshot) {
    const action = refreshing && !errorMessage ? "正在同步" : "正在重连";
    return `${action} · 显示 ${dataAgeMinutes(snapshot)} 分钟前的数据`;
  }
  if (freshness === "expired" && snapshot) {
    return `数据已过期 · 上次成功更新于 ${dataAgeMinutes(snapshot)} 分钟前`;
  }
  return statusCopy(freshness).detail;
}

/** Line under the title: how fresh the numbers are, for whichever source is being watched. */
function headerSubtitle(freshness = dataFreshness()): string {
  if (settingsOpen) return appVersion ? `版本 ${appVersion}` : "监测来源与托盘";
  if (monitoring.codex) return freshness === "fresh" && snapshot ? formatUpdated(snapshot.fetchedAt) : "Codex · Claude 用量";
  if (!monitoring.claude) return "Codex · Claude 用量";
  const fetchedAt = (monitoring.claudeQuota ? claudeQuota?.fetchedAt : undefined) ?? claudeSnapshot?.fetchedAt;
  return fetchedAt ? formatUpdated(fetchedAt) : "Codex · Claude 用量";
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

function loadTrayPreference(): TraySource {
  try {
    return localStorage.getItem(TRAY_SOURCE_KEY) === "claude" ? "claude" : "codex";
  } catch {
    return "codex";
  }
}

/** Sources able to drive the tray ring. Claude needs its subscription windows; token counts have no percentage. */
function traySources(): TraySource[] {
  const sources: TraySource[] = [];
  if (monitoring.codex) sources.push("codex");
  if (monitoring.claude && monitoring.claudeQuota) sources.push("claude");
  return sources;
}

function activeTraySource(): TraySource {
  const available = traySources();
  return available.includes(trayPreference) ? trayPreference : available[0] ?? "codex";
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
    trayPlatformReady = true;
    document.documentElement.dataset.nativeGlass = (await invoke<boolean>("native_glass")) ? "liquid" : "legacy";
  } catch {
    runtimePlatform = "windows";
    trayPlatformReady = true;
  }
  void updateTrayIcon(snapshot);
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

const SOURCE_LABEL: Record<UsageSource, string> = { codex: "Codex 额度监测", claude: "Claude 用量监测", claudeQuota: "Claude 订阅额度" };

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

/** One remaining-quota column: label, big percentage, bar and reset time. */
function quotaCell(source: string, label: string, remaining: number, resetsAt: number | null, windowMinutes: number): string {
  const value = clampPercent(remaining);
  // Tick at the share of the window's time still ahead: a fill reaching past it means the
  // quota is lasting longer than the clock, a fill short of it means it is being spent faster.
  const timeLeft = resetsAt === null ? null : (resetsAt - Date.now() / 1000) / (windowMinutes * 60) * 100;
  const pace = timeLeft !== null && timeLeft > 0 && timeLeft <= 100 ? Math.round(timeLeft) : null;
  return `<div class="quota-window" data-tone="${usageTone(value)}">
    <div class="quota-heading"><span>${label}</span><strong>${value}<small>%</small></strong></div>
    <div class="quota-track" role="meter" aria-label="${source} ${label}剩余" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${value}"${pace !== null ? ` title="额度剩 ${value}%，窗口时间剩 ${pace}%"` : ""}><i style="width:${value}%"></i>${pace !== null ? `<b class="quota-pace" style="left:${pace}%" aria-hidden="true"></b>` : ""}</div>
    <span class="reset-time" title="${formatResetExact(resetsAt)}">${formatReset(resetsAt)}</span>
  </div>`;
}

/** Shared card header: source mark and name, plan, and the details toggle. */
function cardHead(source: "codex" | "claude", plan: string, open: boolean): string {
  const [name, mark, action, controls] = source === "codex"
    ? ["Codex", `<span class="token-mark">${icon("app")}</span>`, "token-details", "token-details"]
    : ["Claude Code", `<span class="token-mark claude-mark">${icon("spark")}</span>`, "claude-details", "claude-details"];
  return `<div class="token-card-head">
    <div>${mark}<strong>${name}</strong>${plan ? `<span class="card-plan">${plan}</span>` : ""}</div>
    <button class="token-detail-button" data-action="${action}" aria-expanded="${open}" aria-controls="${controls}">${open ? "收起" : "明细"}${icon("chevron")}</button>
  </div>`;
}

function renderSettings(): string {
  return `<section id="settings-card" class="settings-content" aria-label="偏好设置">
    <div class="section-caption"><span>通用</span></div>
    <div class="settings-group">
      <label class="setting-row setting-toggle"><span class="setting-label"><i>${icon("power")}</i><span class="setting-copy"><span>登录时启动</span><small>自动驻留托盘</small></span></span><input type="checkbox" data-setting="autostart" aria-label="登录时启动" ${autostartEnabled ? "checked" : ""} ${autostartLoading || !isTauri ? "disabled" : ""}><span class="switch" aria-hidden="true"><i></i></span></label>
      ${traySources().length > 1 ? `<div class="setting-row"><span class="setting-label"><i>${icon("app")}</i><span class="setting-copy"><span>托盘显示</span><small>圆环与小猫跟随所选来源</small></span></span><div class="segmented" role="radiogroup" aria-label="托盘显示来源">${(["codex", "claude"] as TraySource[]).map(source => `<button role="radio" aria-checked="${activeTraySource() === source}" data-action="tray-source" data-value="${source}">${source === "codex" ? "Codex" : "Claude"}</button>`).join("")}</div></div>` : ""}
    </div>
    ${autostartError ? `<p class="inline-error" role="alert">${escapeHtml(autostartError)}</p>` : ""}
    <p class="setting-note">外观跟随系统。Codex 额度每 30–60 秒刷新，Token 统计每 10–30 秒，Claude 订阅额度每 2–5 分钟。</p>
    <div class="section-caption settings-caption"><span>监测</span></div>
    <div class="settings-group">
      ${(["codex", "claude", "claudeQuota"] as UsageSource[]).map(source => {
        const blocked = source === "claudeQuota" && !monitoring.claude;
        const hint = source === "codex" ? "订阅额度与本机 Codex Token"
          : source === "claude" ? "本机 ~/.claude 记录中的 Token"
          : blocked ? "需先开启 Claude 用量监测" : "用 Claude Code 的登录查询 5 小时与每周额度";
        return `<label class="setting-row setting-toggle${source === "claudeQuota" ? " setting-row--child" : ""}"><span class="setting-label"><i>${icon(source === "codex" ? "app" : source === "claude" ? "spark" : "clock")}</i><span class="setting-copy"><span>${SOURCE_LABEL[source]}</span><small>${hint}</small></span></span><input type="checkbox" data-monitor="${source}" aria-label="${SOURCE_LABEL[source]}" ${monitoring[source] && !blocked ? "checked" : ""} ${monitoringBusy === source || blocked ? "disabled" : ""}><span class="switch" aria-hidden="true"><i></i></span></label>`;
      }).join("")}
    </div>
    ${monitoringError ? `<p class="inline-error" role="alert">${escapeHtml(monitoringError)}</p>` : ""}
    <p class="settings-footnote">只读取本机记录里的 Token 数字，不读取对话内容。关闭的来源不再刷新，也不会占用后台资源；设置会在重启后保留。</p>
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
    <strong aria-label="${label}${active ? "（进行中）" : ""} ${spoken}" title="${spoken}">${text.replace(/[万亿]$/, unit => `<small>${unit}</small>`)}</strong>
  </div>`;
}

function renderCodexCard(): string {
  const quota = snapshot;
  const windows = [quota?.primary, quota?.secondary].filter(Boolean) as LimitWindow[];
  const plan = [
    quota?.planType ? escapeHtml(formatPlan(quota.planType)) : "",
    quota?.resetCreditsAvailable != null ? `可重置 ${Math.max(0, Math.floor(quota.resetCreditsAvailable))} 次` : "",
  ].filter(Boolean).join(" · ");
  const data = tokenSnapshot;
  const available = Boolean(data?.sourceAvailable);
  const recent = data?.recentTurn ?? null;
  const today = data?.today;
  const session = data?.currentSession ?? null;
  // Only say something when there is a state worth reading; the privacy line lives in settings.
  const note = tokenError
    ? "Token 统计暂时无法读取"
    : tokenLoading && !data
      ? "正在读取本机统计"
      : !available
        ? "尚未发现本机 Codex 会话记录"
        : recent?.active
          ? "最近一轮仍在进行"
          : "";

  return `
    <section class="token-card" aria-label="Codex 用量">
      ${cardHead("codex", plan, tokenDetailsOpen)}
      <div class="card-quota" role="group" aria-label="Codex 剩余额度">
        ${windows.length
          ? `<div class="quota-grid">${windows.map(item => quotaCell("Codex", formatWindow(item.windowDurationMins), remainingOf(item), item.resetsAt, item.windowDurationMins)).join("")}</div>`
          : `<div class="quota-empty">${icon(loading ? "clock" : "alert")}<span>${escapeHtml(statusCopy().label)}</span><button class="text-button" data-action="refresh" ${refreshing ? "disabled" : ""}>重试</button></div>`}
      </div>
      <div class="token-summary-grid" role="group" aria-label="Codex Token 摘要">
        ${tokenStat("最近一轮", recent?.totalTokens, available, Boolean(recent?.active))}
        ${tokenStat("今日累计", today?.totalTokens, available)}
        ${tokenStat("当前会话", session?.totalTokens, available)}
      </div>
      ${tokenDetailsOpen ? `
        <div class="token-details${detailsEntering === "token" ? " is-entering" : ""}" id="token-details">
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
      ${note ? `<p class="token-note${tokenError ? " token-error" : ""}" role="status">${note}</p>` : ""}
    </section>`;
}

function formatModel(model: string): string {
  return model.replace(/^claude-/, "").replace(/-(\d+)-(\d+)$/, " $1.$2").replace(/^./, c => c.toUpperCase());
}

const CLAUDE_QUOTA_HINT: Record<ClaudeQuotaSnapshot["status"], string> = {
  ok: "",
  no_credentials: "未找到 Claude Code 登录。在终端安装并登录 claude 命令行后会自动读取。",
  expired: "Claude Code 登录正在续期或续期失败，Meter 会自动重试；持续出现时在终端运行一次 claude。",
  unauthorized: "Claude Code 登录已失效，请在终端重新登录 claude。",
  rate_limited: "查询过于频繁，稍后自动重试。",
  error: "暂时无法获取 Claude 订阅额度。",
};

/** Subscription windows on top of the Claude card; local token stats follow below. */
function renderClaudeQuota(): string {
  if (!monitoring.claudeQuota) {
    return `<div class="card-quota card-quota--off"><span>订阅额度 <small>用 Claude Code 的登录查询 5 小时与每周额度</small></span>${sourceSwitch("claudeQuota")}</div>`;
  }
  const data = claudeQuota;
  if (!data) return `<div class="card-quota"><p class="token-note">正在查询 Claude 订阅额度…</p></div>`;
  const shown = ([["5 小时", data.fiveHour, 300], ["每周", data.sevenDay, 10080]] as Array<[string, ClaudeQuotaWindow | null, number]>)
    .filter((entry): entry is [string, ClaudeQuotaWindow, number] => Boolean(entry[1]));
  const extra = ([["Opus 每周", data.sevenDayOpus], ["Sonnet 每周", data.sevenDaySonnet]] as Array<[string, ClaudeQuotaWindow | null]>)
    .filter((entry): entry is [string, ClaudeQuotaWindow] => Boolean(entry[1]))
    .map(([label, item]) => `${label}剩余 ${clampPercent(item.remainingPercent)}%`).join(" · ");
  const hint = data.status !== "ok" ? CLAUDE_QUOTA_HINT[data.status] || data.message || "" : "";
  if (!shown.length) {
    return `<div class="card-quota"><p class="token-note claude-quota-hint">${escapeHtml(hint)}</p></div>`;
  }
  const age = data.stale ? `<p class="token-note claude-quota-hint">显示 ${Math.max(1, Math.round((Date.now() / 1000 - data.fetchedAt) / 60))} 分钟前的数据 · ${escapeHtml(hint)}</p>` : "";
  return `<div class="card-quota${data.stale ? " is-stale" : ""}" role="group" aria-label="Claude 订阅额度">
    <div class="quota-grid">${shown.map(([label, item, minutes]) => quotaCell("Claude", label, item.remainingPercent, item.resetsAt, minutes)).join("")}</div>
    ${extra ? `<p class="token-note">${extra}</p>` : ""}${age}
  </div>`;
}

function renderClaudeUsage(): string {
  const data = claudeSnapshot;
  if (!monitoring.claude) return renderMonitorOff("claude");
  if (isTauri && data && !data.sourceAvailable) {
    return `<section class="token-card claude-card" aria-label="Claude 用量">
      <div class="token-card-head"><div><span class="token-mark claude-mark">${icon("spark")}</span><strong>Claude Code</strong></div></div>
      <p class="token-note">尚未发现本机 Claude Code 记录</p>
    </section>`;
  }
  const available = Boolean(data?.sourceAvailable);
  const block = data?.currentBlock ?? null;
  const session = data?.currentSession ?? null;
  const today = data?.today;
  // With real subscription windows above, the locally estimated window needs no time bar of its own.
  const showBlockClock = Boolean(block) && !monitoring.claudeQuota;
  const blockProgress = block ? clampPercent(((Date.now() / 1000) - block.startedAt) / (block.resetsAt - block.startedAt) * 100) : 0;
  // Cache reads dominate Claude totals (often >95%), so the headline counts input + output only.
  const io = (value: ClaudeTokenBreakdown | null | undefined) => value ? value.inputTokens + value.outputTokens : undefined;
  const note = !data
    ? "正在读取本机 Claude Code 记录"
    : !block
      ? "当前没有活跃的 5 小时窗口 · Token 数不含缓存"
      : showBlockClock
        ? `本机估算窗口 ${formatReset(block.resetsAt)} · Token 数不含缓存`
        : "Token 数为输入加输出，不含缓存";
  const row = (label: string, key: keyof ClaudeTokenBreakdown) =>
    `<tr${key === "totalTokens" ? ' class="token-total-row"' : ""}><th scope="row">${label}</th>${renderTokenTableCell(block?.[key], available && Boolean(block))}${renderTokenTableCell(today?.[key], available)}${renderTokenTableCell(session?.[key], available && Boolean(session))}</tr>`;
  const plan = monitoring.claudeQuota && claudeQuota?.plan ? escapeHtml(formatPlan(claudeQuota.plan)) : "";
  return `
    <section class="token-card claude-card" aria-label="Claude 用量">
      ${cardHead("claude", plan, claudeDetailsOpen)}
      ${renderClaudeQuota()}
      <div class="token-summary-grid" role="group" aria-label="Claude 用量摘要（输入加输出）">
        ${tokenStat("5 小时窗口", io(block), available && Boolean(block), Boolean(block))}
        ${tokenStat("今日累计", io(today), available)}
        ${tokenStat("当前会话", io(session), available && Boolean(session))}
      </div>
      ${showBlockClock ? `<div class="quota-track claude-window" role="progressbar" aria-label="5 小时窗口已过时间" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${blockProgress}"><i style="width:${blockProgress}%"></i></div>` : ""}
      ${claudeDetailsOpen ? `
        <div class="token-details${detailsEntering === "claude" ? " is-entering" : ""}" id="claude-details">
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
        <div class="brand-line">${settingsOpen ? `<button class="icon-button back-button" data-action="settings" aria-label="返回主页">${icon("back")}</button>` : `<span class="app-mark">${icon("app")}</span>`}<div><h1>${settingsOpen ? "偏好设置" : "Codex Meter"}</h1><span class="brand-subtitle">${escapeHtml(headerSubtitle(freshness))}</span></div></div>
        <div class="header-actions">${!isTauri ? '<span class="mock-badge">预览</span>' : ""}${!settingsOpen ? `<button class="icon-button header-refresh" data-action="refresh" aria-label="刷新用量" title="刷新用量" aria-busy="${refreshing}" ${refreshing ? "disabled" : ""}>${icon("refresh")}</button><button class="icon-button settings-button" data-action="settings" aria-label="偏好设置" title="偏好设置" aria-expanded="false">${icon("settings")}</button>` : ""}</div>
      </header>
      <div class="panel-scroll${changedView ? " view-enter" : ""}">
        ${settingsOpen ? renderSettings() : `${monitoring.codex ? renderCodexCard() : renderMonitorOff("codex")}${renderClaudeUsage()}`}
      </div>
      <footer class="panel-footer"><div class="updated" role="status" title="${escapeHtml(statusCopy().detail)}">${footerStatusCopy(freshness) ? `${icon(state === "loading" ? "clock" : state === "paused" ? "power" : "alert")}<span>${escapeHtml(footerStatusCopy(freshness))}</span>` : ""}</div>${exitArmed ? `<button class="text-button exit-confirm" data-action="exit" aria-label="再次点击确认退出 Codex Meter">确认退出</button>` : `<button class="icon-button exit" data-action="exit" aria-label="退出 Codex Meter" title="退出 Codex Meter">${icon("exit")}</button>`}</footer>
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
  detailsEntering = null;
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
    const hiddenContent = scroll ? Math.max(0, Math.min(scroll.scrollHeight, 680) - scroll.clientHeight) : 0;
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
    if (source === "claude" && !enabled) { claudeSnapshot = null; claudeQuota = null; }
    if (source === "claudeQuota" && !enabled) claudeQuota = null;
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
  if (!monitoring.claude) return "";
  const quota = monitoring.claudeQuota && claudeQuota && (claudeQuota.status === "ok" || claudeQuota.stale) ? claudeQuota : null;
  if (quota && (quota.fiveHour || quota.sevenDay)) {
    const parts = ([["5 小时", quota.fiveHour], ["每周", quota.sevenDay]] as Array<[string, ClaudeQuotaWindow | null]>)
      .filter((entry): entry is [string, ClaudeQuotaWindow] => Boolean(entry[1]))
      .map(([label, item]) => `${label} ${clampPercent(item.remainingPercent)}%`);
    return `\nClaude 剩余 · ${parts.join(" · ")}`;
  }
  const data = claudeSnapshot;
  if (!data?.sourceAvailable) return "";
  const value = data.currentBlock ?? data.today;
  return `\nClaude · ${data.currentBlock ? "5 小时" : "今日"} ${formatTokenSummary(value.inputTokens + value.outputTokens)}`;
}

interface TrayRing {
  remaining: number;
  color: string;
}

interface TrayPresentation {
  mood: CatMood;
  /** One ring around the cat for the window that matters right now; null draws only the track. */
  ring: TrayRing | null;
  dimmed: boolean;
  alertDot: boolean;
  /** Native menu bar text on macOS; empty hides it. */
  title: string;
  tooltip: string;
}

interface TrayWindow {
  minutes: number;
  remaining: number;
}

const TRAY_IDLE_COLOR = "#7890aa";
const WEEKLY_TITLE_BELOW = 30;

/** Short label used in the menu bar when a non-5-hour window is the binding one. */
function shortWindow(minutes: number): string {
  if (minutes === 10080) return "周";
  if (minutes % 1440 === 0) return `${minutes / 1440}天`;
  if (minutes % 60 === 0) return `${minutes / 60}时`;
  return `${minutes}分`;
}

function trayMood(lowest: number, exhausted: boolean): CatMood {
  if (lowest === 0 && exhausted) return "exhausted";
  return lowest >= 50 ? "healthy" : lowest >= 20 ? "warning" : "critical";
}

/**
 * Picks the window the ring and the menu bar text both show. The first (5-hour) window is the
 * one that moves; another takes over only once it is both tighter and actually running low.
 */
function trayReadout(windows: TrayWindow[]): { ring: TrayRing; title: string; detail: string; lowest: number } {
  const first = windows[0];
  const tightest = windows.reduce((low, item) => item.remaining < low.remaining ? item : low);
  const shown = tightest !== first && tightest.remaining < WEEKLY_TITLE_BELOW ? tightest : first;
  const lightSurface = runtimePlatform === "macos" && !themeQuery.matches;
  return {
    ring: { remaining: shown.remaining, color: usageColor(shown.remaining, lightSurface) },
    title: shown === first ? `${shown.remaining}%` : `${shortWindow(shown.minutes)} ${shown.remaining}%`,
    detail: windows.map(item => `${formatWindow(item.minutes)} ${item.remaining}%`).join(" · "),
    lowest: tightest.remaining,
  };
}

function codexTray(data: UsageSnapshot | null): TrayPresentation {
  if (!monitoring.codex) {
    return { mood: "sleeping", ring: null, dimmed: true, alertDot: false, title: "", tooltip: "Codex 额度监测已关闭" };
  }
  const windows = ([data?.primary, data?.secondary].filter(Boolean) as LimitWindow[])
    .map(item => ({ minutes: item.windowDurationMins, remaining: remainingOf(item) }));
  const freshness = dataFreshness();
  if (!data || !windows.length) {
    const unavailable = freshness === "unavailable";
    return {
      mood: "neutral", ring: null, dimmed: true, alertDot: unavailable,
      title: unavailable ? "—" : "…",
      tooltip: unavailable ? "Codex 暂时无法获取用量" : "Codex 正在获取用量",
    };
  }
  const { ring, title, detail, lowest } = trayReadout(windows);
  if (freshness === "expired") {
    return { mood: "sleeping", ring, dimmed: true, alertDot: true, title, tooltip: `Codex 数据已过期 · ${detail}` };
  }
  const prefix = freshness === "reconnecting" ? "Codex 正在重连" : "Codex 剩余";
  return { mood: trayMood(lowest, data.status === "limit_reached"), ring, dimmed: false, alertDot: false, title, tooltip: `${prefix} · ${detail}` };
}

function claudeTray(): TrayPresentation {
  const quota = claudeQuota;
  const windows = ([[300, quota?.fiveHour], [10080, quota?.sevenDay]] as Array<[number, ClaudeQuotaWindow | null | undefined]>)
    .filter((entry): entry is [number, ClaudeQuotaWindow] => Boolean(entry[1]))
    .map(([minutes, item]) => ({ minutes, remaining: clampPercent(item.remainingPercent) }));
  if (!quota || !windows.length) {
    return {
      mood: "neutral", ring: null, dimmed: true, alertDot: Boolean(quota),
      title: quota ? "—" : "…",
      tooltip: quota ? "Claude 订阅额度暂时无法获取" : "Claude 正在查询订阅额度",
    };
  }
  const { ring, title, detail, lowest } = trayReadout(windows);
  const prefix = quota.stale ? "Claude 正在重连" : "Claude 剩余";
  return { mood: trayMood(lowest, true), ring, dimmed: false, alertDot: false, title, tooltip: `${prefix} · ${detail}` };
}

/** The chosen source drives the ring, cat and menu bar text; the other one is appended to the tooltip. */
function trayPresentation(data: UsageSnapshot | null): TrayPresentation {
  if (activeTraySource() === "claude") {
    const presentation = claudeTray();
    return monitoring.codex ? { ...presentation, tooltip: `${presentation.tooltip}\n${codexTray(data).tooltip}` } : presentation;
  }
  const presentation = codexTray(data);
  return { ...presentation, tooltip: presentation.tooltip + claudeTooltip() };
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

/** Tray artwork is drawn in a 64-unit square and scaled to the platform's pixel size. */
const TRAY_PIXELS = { macos: 44, windows: 64 } as const;

function drawTrayArtwork(context: CanvasRenderingContext2D, presentation: TrayPresentation, pixels: number): void {
  const darkMode = themeQuery.matches;
  const isMacOS = runtimePlatform === "macos";
  context.clearRect(0, 0, pixels, pixels);
  context.save();
  context.scale(pixels / 64, pixels / 64);

  if (!isMacOS) {
    // Taskbars can be light or dark; a glass disc keeps the rings legible on both.
    const glass = context.createLinearGradient(6, 2, 58, 62);
    glass.addColorStop(0, darkMode ? "rgba(31, 61, 81, .96)" : "rgba(36, 74, 96, .95)");
    glass.addColorStop(1, darkMode ? "rgba(5, 17, 30, .98)" : "rgba(9, 28, 43, .97)");
    context.beginPath();
    context.arc(32, 32, 31.5, 0, Math.PI * 2);
    context.fillStyle = glass;
    context.fill();
  }

  // One thick ring around the cat. It fills clockwise from 12 o'clock with what remains,
  // so a full ring means plenty left.
  const onGlass = !isMacOS || darkMode;
  context.lineWidth = 8;
  context.lineCap = "round";
  context.beginPath();
  context.arc(32, 32, 27.5, 0, Math.PI * 2);
  context.strokeStyle = onGlass ? "rgba(231, 248, 255, .24)" : "rgba(10, 31, 47, .2)";
  context.stroke();
  const ring = presentation.ring;
  if (ring && ring.remaining > 0) {
    const start = -Math.PI / 2;
    context.beginPath();
    context.arc(32, 32, 27.5, start, start + Math.PI * 2 * Math.min(1, ring.remaining / 100));
    context.strokeStyle = presentation.dimmed ? TRAY_IDLE_COLOR : ring.color;
    context.stroke();
  }

  // The cat avatar fills the inside of the ring.
  context.save();
  context.translate(32, 33.5);
  context.scale(.9, .9);
  context.translate(-32, -27);
  if (presentation.dimmed) context.globalAlpha = .72;
  drawCatFace(context, presentation.mood);
  context.restore();

  if (presentation.alertDot) {
    context.beginPath();
    context.arc(53, 11, 7, 0, Math.PI * 2);
    context.fillStyle = "rgba(4, 15, 26, .9)";
    context.fill();
    context.beginPath();
    context.arc(53, 11, 5, 0, Math.PI * 2);
    context.fillStyle = "#f2ae42";
    context.fill();
  }
  context.restore();
}

let trayPlatformReady = !isTauri;

async function updateTrayIcon(data: UsageSnapshot | null): Promise<void> {
  // Until the platform is known the artwork would use the wrong size and layout.
  if (!isTauri || !trayPlatformReady) return;
  const pixels = runtimePlatform === "macos" ? TRAY_PIXELS.macos : TRAY_PIXELS.windows;
  const presentation = trayPresentation(data);
  const tooltip = presentation.tooltip;
  // Background events arrive every few seconds; skip the IPC when nothing visible changed.
  const trayKey = JSON.stringify([presentation, tooltip, themeQuery.matches, runtimePlatform]);
  if (trayKey === lastTrayKey) return;
  const canvas = document.createElement("canvas");
  canvas.width = pixels;
  canvas.height = pixels;
  const context = canvas.getContext("2d");
  if (!context) return;
  drawTrayArtwork(context, presentation, pixels);
  const rgba = Array.from(context.getImageData(0, 0, pixels, pixels).data);
  try {
    await invoke("update_tray_icon", {
      rgba,
      width: pixels,
      height: pixels,
      title: runtimePlatform === "macos" ? presentation.title : null,
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
      // One table at a time keeps the panel inside its height without scrolling.
      if (claudeDetailsOpen) { tokenDetailsOpen = false; detailsEntering = "claude"; }
      render();
      app.querySelector<HTMLButtonElement>('[data-action="claude-details"]')?.focus();
      break;
    case "token-details":
      tokenDetailsOpen = !tokenDetailsOpen;
      if (tokenDetailsOpen) { claudeDetailsOpen = false; detailsEntering = "token"; }
      render();
      app.querySelector<HTMLButtonElement>('[data-action="token-details"]')?.focus();
      break;
    case "tray-source":
      trayPreference = button.dataset.value === "claude" ? "claude" : "codex";
      try {
        localStorage.setItem(TRAY_SOURCE_KEY, trayPreference);
      } catch {
        // The choice still applies until the app restarts.
      }
      render();
      app.querySelector<HTMLButtonElement>(`[data-action="tray-source"][data-value="${trayPreference}"]`)?.focus();
      void updateTrayIcon(snapshot);
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
    if (event.key !== "Escape") return;
    // Escape steps back out of settings first; a second press closes the panel.
    if (settingsOpen) {
      settingsOpen = false;
      render();
      app.querySelector<HTMLButtonElement>('[data-action="settings"]')?.focus();
      return;
    }
    void invoke("hide_panel").catch(() => undefined);
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
  void listen<ClaudeQuotaSnapshot>("usage://claude-quota", ({ payload }) => {
    if (!monitoring.claudeQuota || !monitoring.claude) return;
    // A failed refresh keeps the last good windows on screen, marked stale, instead of blanking them.
    claudeQuota = payload.status !== "ok" && claudeQuota && (claudeQuota.fiveHour || claudeQuota.sevenDay)
      ? { ...claudeQuota, status: payload.status, message: payload.message, stale: true }
      : { ...payload, stale: false };
    render();
    void updateTrayIcon(snapshot);
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
  void getVersion().then((version) => {
    appVersion = version;
    if (settingsOpen) render();
  }).catch(() => undefined);
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
  const subtitle = app.querySelector<HTMLElement>(".brand-subtitle");
  if (subtitle) subtitle.textContent = headerSubtitle(freshness);
  const updated = app.querySelector<HTMLElement>(".updated span");
  if (updated && !refreshing) {
    updated.textContent = footerStatusCopy(freshness);
  }
}, 30_000);


themeQuery.addEventListener("change", () => {
  void updateTrayIcon(snapshot);
});
