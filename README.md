# Codex Meter

Codex Meter 是一款面向 Windows 系统托盘和 macOS 菜单栏的轻量 Codex 用量查看工具。

它通过本机官方 `codex app-server` 读取当前 ChatGPT 账户的用量窗口，并使用平台适配的玻璃小猫状态图标与轻薄玻璃气泡面板展示剩余额度、重置时间和套餐类型。

## 当前状态

| 平台 | 状态 | 产物 |
| --- | --- | --- |
| Windows 10/11 | 已完成首个可验证版本 | `codex-meter.exe` |
| macOS | 由 GitHub Actions 构建，等待真机验收 | `.app` / `.dmg`（ad-hoc 签名） |

Windows 版本已验证生产构建、单实例、右键菜单、深色模式、窄尺寸布局和基础交互。macOS 仍需在真实 Mac 上验证菜单栏定位、Retina 缩放、Vibrancy 效果和应用签名。

## 主要功能

- 显示 Codex 5 小时和每周用量窗口。
- Windows 托盘只显示方形玻璃小猫，通过表情和耳朵姿态表达用量状态。
- macOS 菜单栏将玻璃小猫与进度条左右排列，同时表达状态和剩余额度。
- 小猫采用深蓝玻璃本体、霓虹状态轮廓、高光大眼和极简嘴型。
- 自动选择剩余比例更低的窗口作为托盘主状态。
- 展示本地时区下的额度重置时间。
- 接口支持时展示账户当前可用的额度重置次数。
- 根据剩余用量显示不同的轻松提示文案。
- 自动识别 Plus、Pro、Team、Business 等套餐名称。
- 每分钟自动刷新，也可手动立即刷新。
- 可在设置中开启“随系统登录启动”，默认关闭。
- 刷新失败时保留最后一次成功结果并标记为旧数据。
- 5 分钟内的短暂失败显示“正在重连”，超过 5 分钟才进入数据过期状态。
- 跟随系统浅色/深色模式。
- 支持上下左右任务栏、DPI 缩放和工作区边界限制。
- 点击窗口外部或按 `Esc` 自动收起面板。
- 单实例运行，重复启动只会唤起已有程序。

## 界面设计

- 轻薄玻璃质感：半透明背景、细边框、高光和柔和阴影。
- 气泡箭头自动指向托盘图标。
- 无标题栏、无任务栏窗口按钮、无浏览器右键开发菜单。
- 设置、加载、无数据、过期和错误状态均有明确反馈。

## 数据来源与准确性

Codex Meter 使用本机 Codex CLI 提供的 `codex app-server` JSON-RPC 接口：

```text
initialize
  → initialized
  → account/read
  → account/rateLimits/read
```

用量口径：

- 后端返回 `usedPercent`，界面展示 `remainingPercent = 100 - usedPercent`。
- 根据 `windowDurationMins` 识别 5 小时和每周窗口，不依赖返回数组顺序。
- 套餐类型优先采用实时 rate limits 响应，避免显示过期账户信息。
- `resetsAt` 按 Unix 秒解析，并使用系统时区显示。
- Token 摘要来自本机 Codex 会话文件中的独立 `token_count` 事件，通过累计值差分计算最近一轮、今日累计和当前会话。

## 隐私与安全边界

- 不读取或复制 `~/.codex/auth.json`。
- 读取 `~/.codex/sessions` 和 `~/.codex/archived_sessions` 时只解析相关事件的类型、时间戳和 token 数字，不解析或保存提示词、回复与代码内容。
- 不保存 OpenAI access token、refresh token 或浏览器 Cookie。
- 不直接调用未公开的 `chatgpt.com/backend-api/wham/usage`。
- 登录和令牌刷新完全交给用户已安装的 Codex CLI/App Server。
- 不上传用量记录，缓存仅保存在本机。

## 运行要求

- 已有可用的 Codex 登录：macOS 可使用新版 ChatGPT/Codex 桌面程序内置版本；其他情况需让终端可以正常运行 `codex --version`。
- macOS 会自动识别 `/Applications/ChatGPT.app`、旧版 `/Applications/Codex.app` 及用户应用目录中的内置 Codex，无需额外配置。
- Windows 需要 WebView2；Windows 10/11 通常已预装。

如果 Codex CLI 不在系统路径中，可以通过环境变量指定：

```powershell
$env:CODEX_METER_CODEX_PATH = "C:\path\to\codex.exe"
```

## 本地开发

需要 Node.js 20+、Rust stable 和对应平台的桌面构建工具。

Windows 需要 Visual Studio C++ Build Tools，macOS 需要 Xcode Command Line Tools。

```text
npm install
npm run tauri:dev
```

仅预览前端界面：

```text
npm run dev
```

浏览器预览使用明确标记的演示数据，不会连接真实 Codex 账户。

## 构建

Windows：

```text
npm run tauri -- build
```

macOS 必须在 Mac 上构建：

```text
npm ci
npm run tauri -- build --bundles app,dmg
```

测试版使用 ad-hoc 签名，避免 Apple Silicon 将下载包直接判定为损坏；首次打开仍可能需要在“隐私与安全性”中允许。用于公开分发时，仍建议配置 Apple Developer 证书、公证和 Stapling。

## GitHub Actions 自动打包

仓库中的 `构建 Windows 和 macOS 安装包` 工作流会在推送到 `main` 分支或手动触发时构建：

- Windows x64：便携版 `.exe` 和 NSIS 安装包。
- macOS Apple Silicon：未签名 `.app` 和 `.dmg`。
- macOS Intel：未签名 `.app` 和 `.dmg`。

构建完成后，可在 GitHub 仓库的 **Actions → 对应运行记录 → Artifacts** 下载，产物保留 14 天。

## Code signing policy

本项目计划通过 SignPath Foundation 为开源版本提供免费代码签名。签名流程、团队职责和隐私声明见 [CODE_SIGNING_POLICY.md](CODE_SIGNING_POLICY.md)。

## 开源许可证

本项目采用 [MIT License](LICENSE)。

## 验证命令

```text
npm run typecheck
npm run build
cargo fmt --manifest-path src-tauri/Cargo.toml --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo check --manifest-path src-tauri/Cargo.toml
```

## 技术栈

- Tauri 2
- Rust
- TypeScript
- Vite
- 原生 HTML/CSS，无 React 和额外 UI 框架

后台由 Rust 负责 Codex App Server 通信、托盘状态和窗口定位；WebView 只负责轻量界面渲染。

## 已知限制

- macOS 尚未真机打包和视觉验收。
- Windows 原生 Acrylic 在部分 WebView2 环境可能导致灰屏，目前默认使用稳定的 CSS 轻玻璃方案。
- Windows 安装包仍需完成签名和更多 DPI、多显示器测试。
- macOS App Store 版本需要重新评估私有透明窗口 API。

## 项目结构

```text
src/                 前端界面与样式
src-tauri/src/       Rust 后端、托盘和窗口逻辑
src-tauri/icons/     Windows/macOS 应用图标
src-tauri/tauri.conf.json
```
