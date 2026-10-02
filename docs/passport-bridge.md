# Passport Bridge integration

Meter owns only the Bridge it starts. Open **Settings / Passport** from the tray or menu bar, save the three absolute paths, then enable the switch. Disable the switch to stop it. Closing the panel keeps it running; quitting Meter stops its process tree. Meter never enables the LAN service at login or restart, never attaches to an existing service, and refuses an occupied port.

## Initial configuration

This development integration requires a Node executable, a compatible Passport `bridge/server.mjs` directory with its `ws` dependency, and an environment JSON file. These paths are stored in the application's configuration directory; environment values are read only by Rust and passed to the child, never returned to the webview or logged. Protect the environment file and TLS key with OS file permissions. Configure secrets via that environment file, not in application source.

The environment file is a JSON object whose values are strings. Required variables are `PASSPORT_TOKEN`, `PASSPORT_DEVICE_TOKEN`, `PASSPORT_TLS_CERT`, and `PASSPORT_TLS_KEY`. Tokens must be separate, 32–128 URL-safe characters. Optional variables include `PASSPORT_PORT` (default 8765), `PASSPORT_DESKTOP_THREAD`, `PASSPORT_DESKTOP_CHATS`, `CODEX_DESKTOP_IPC_PATH`, and `CODEX_BIN`. Only `PASSPORT_*` and the two named Codex variables are accepted. Meter forces LAN mode with TLS and desktop mode. Use absolute certificate/key paths. The certificate must be trusted by the device and cover `127.0.0.1` for Meter's HTTPS health probe. For tests use a separate ephemeral port, independent tokens, and a test certificate.

Status comes from the Bridge `/healthz` endpoint over certificate-verified HTTPS, with proxies disabled and a short timeout. It distinguishes a running process from a connected device. Device connected does not certify approval synchronization or that Codex Desktop is reachable. The current Passport desktop integration has known experimental protocol/selection issues. First computer binding still requires USB; wireless first binding and discovery are not implemented here.

## Distribution without a Node installation

The intended release path is to ship a private Node runtime and a pinned Bridge source/dependency bundle inside Meter's resources for each supported OS/architecture, then resolve them through Tauri's resource directory. The supervisor already accepts those executable/script paths without shell commands or a visible terminal (Windows uses `CREATE_NO_WINDOW`). This change does **not** include runtime binaries or automatically resolve bundled resources. The release is therefore not yet a self-contained installer. Do not distribute a snapshot of uncommitted Passport desktop experiments as a stable Bridge.

Before shipping, pin a reviewed Bridge revision and Node version, include their licenses, create bundles for Windows x64/ARM64 and macOS Intel/Apple Silicon as supported, sign/notarize the runtime alongside Meter, and test paths with spaces, upgrades, firewall prompts, certificate provisioning and process-tree shutdown on both operating systems. Startup currently reports failures without exposing child stderr, since upstream logs may contain sensitive data. A sanitized structured error protocol should precede richer diagnostics.

## Validation scope

Rust tests cover disabled defaults, idempotent stop, owned-process cleanup and crash detection on Unix, port exclusion, and redacted configuration errors. Frontend build checks TypeScript and Vite. Windows process-tree shutdown uses `taskkill /T /F` and requires Windows validation. The port check has a bind-to-spawn race; if another service acquires it, the new Bridge exits, and Meter never kills that service.
