use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    net::{Ipv4Addr, SocketAddrV4, TcpListener},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    time::Duration,
};
use tauri::{Manager, State};

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    runtime: String,
    script: String,
    environment_file: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    config: Config,
    running: bool,
    connected: bool,
    message: String,
}
#[derive(Default)]
pub struct Bridge {
    config: Config,
    child: Option<Child>,
    probe: Option<(reqwest::blocking::Client, u16)>,
}
pub struct PassportState(pub Arc<Mutex<Bridge>>);
impl Default for PassportState {
    fn default() -> Self {
        Self(Arc::new(Mutex::new(Bridge::default())))
    }
}
impl Bridge {
    pub fn stop(&mut self) -> Result<(), String> {
        if let Some(child) = self.child.as_mut() {
            if child
                .try_wait()
                .map_err(|_| "无法检查 Bridge 进程")?
                .is_none()
            {
                #[cfg(unix)]
                {
                    // Child owns a new process group, including optional quota workers.
                    if unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) } != 0 {
                        return Err("无法停止 Bridge 进程组".into());
                    }
                }
                #[cfg(windows)]
                {
                    use std::os::windows::process::CommandExt;
                    let result = Command::new("taskkill")
                        .args(["/PID", &child.id().to_string(), "/T", "/F"])
                        .creation_flags(0x08000000)
                        .stdout(Stdio::null())
                        .stderr(Stdio::null())
                        .status()
                        .map_err(|_| "无法停止 Bridge 进程树")?;
                    if !result.success() {
                        return Err("无法停止 Bridge 进程树".into());
                    }
                }
            }
            child.wait().map_err(|_| "无法回收 Bridge 进程")?;
        }
        self.child = None;
        self.probe = None;
        Ok(())
    }
    fn status(&mut self) -> Result<Status, String> {
        let mut message = "已关闭；开启后允许局域网设备连接".to_owned();
        if let Some(child) = self.child.as_mut() {
            if child
                .try_wait()
                .map_err(|_| "无法检查 Bridge 进程")?
                .is_some()
            {
                self.child = None;
                self.probe = None;
                message = "Bridge 已退出，请检查运行时、配置与端口".into();
            }
        }
        let running = self.child.is_some();
        let mut connected = false;
        if running {
            message = "正在启动或等待 Bridge 响应".into();
            if let Some((client, port)) = &self.probe {
                if let Ok(response) = client
                    .get(format!("https://127.0.0.1:{port}/healthz"))
                    .send()
                {
                    if let Ok(value) = response
                        .error_for_status()
                        .and_then(|r| r.json::<serde_json::Value>())
                    {
                        connected = value
                            .get("connected")
                            .and_then(|v| v.as_bool())
                            .unwrap_or(false);
                        message = if connected {
                            "设备已连接"
                        } else {
                            "Bridge 已启动，等待设备连接"
                        }
                        .into();
                    }
                }
            }
        }
        Ok(Status {
            config: self.config.clone(),
            running,
            connected,
            message,
        })
    }
}
impl Drop for Bridge {
    fn drop(&mut self) {
        let _ = self.stop();
    }
}
fn config_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_config_dir()
        .map(|p| p.join("passport.json"))
        .map_err(|_| "无法定位应用配置目录".into())
}
fn environment(path: &str) -> Result<BTreeMap<String, String>, String> {
    let bytes = fs::read(path).map_err(|_| "无法读取 Bridge 环境配置文件")?;
    if bytes.len() > 65536 {
        return Err("Bridge 配置文件过大".into());
    }
    let env: BTreeMap<String, String> =
        serde_json::from_slice(&bytes).map_err(|_| "Bridge 环境配置必须是 JSON 字符串映射")?;
    if env.keys().any(|k| {
        !k.starts_with("PASSPORT_") && !matches!(k.as_str(), "CODEX_BIN" | "CODEX_DESKTOP_IPC_PATH")
    }) {
        return Err("配置包含不支持的环境变量".into());
    }
    for key in [
        "PASSPORT_TOKEN",
        "PASSPORT_DEVICE_TOKEN",
        "PASSPORT_TLS_CERT",
        "PASSPORT_TLS_KEY",
    ] {
        if !env.get(key).is_some_and(|v| !v.is_empty()) {
            return Err(format!("环境配置缺少 {key}"));
        }
    }
    let valid = |s: &str| {
        (32..=128).contains(&s.len())
            && s.bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
    };
    if !valid(&env["PASSPORT_TOKEN"])
        || !valid(&env["PASSPORT_DEVICE_TOKEN"])
        || env["PASSPORT_TOKEN"] == env["PASSPORT_DEVICE_TOKEN"]
    {
        return Err("控制 token 与设备 token 必须有效且独立".into());
    }
    if env.get("PASSPORT_HOST").is_some_and(|v| v != "0.0.0.0") {
        return Err("Bridge 主机地址必须为 0.0.0.0".into());
    }
    Ok(env)
}
fn read_status(app: tauri::AppHandle, state: Arc<Mutex<Bridge>>) -> Result<Status, String> {
    let mut bridge = state.lock().map_err(|_| "Bridge 管理器不可用")?;
    if bridge.child.is_none() && bridge.config.environment_file.is_empty() {
        if let Ok(bytes) = fs::read(config_path(&app)?) {
            bridge.config = serde_json::from_slice(&bytes).map_err(|_| "Meter Bridge 配置损坏")?;
        }
    }
    bridge.status()
}
fn configure(
    app: tauri::AppHandle,
    state: Arc<Mutex<Bridge>>,
    config: Config,
) -> Result<Status, String> {
    let mut bridge = state.lock().map_err(|_| "Bridge 管理器不可用")?;
    if bridge.child.is_some() {
        return Err("请先关闭 Bridge 再修改配置".into());
    }
    for path in [&config.runtime, &config.script, &config.environment_file] {
        if !Path::new(path).is_absolute() || !Path::new(path).is_file() {
            return Err("请选择存在的绝对文件路径".into());
        }
    }
    environment(&config.environment_file)?;
    let path = config_path(&app)?;
    fs::create_dir_all(path.parent().ok_or("无效配置路径")?).map_err(|_| "无法创建配置目录")?;
    fs::write(
        path,
        serde_json::to_vec(&config).map_err(|_| "无法编码配置")?,
    )
    .map_err(|_| "无法保存配置")?;
    bridge.config = config;
    bridge.status()
}
fn toggle(state: Arc<Mutex<Bridge>>, enabled: bool) -> Result<Status, String> {
    let mut bridge = state.lock().map_err(|_| "Bridge 管理器不可用")?;
    if !enabled {
        bridge.stop()?;
        return bridge.status();
    }
    if bridge.child.is_some() {
        return bridge.status();
    }
    let env = environment(&bridge.config.environment_file)?;
    let port: u16 = env
        .get("PASSPORT_PORT")
        .map(String::as_str)
        .unwrap_or("8765")
        .parse()
        .map_err(|_| "无效 Bridge 端口")?;
    if port == 0 {
        return Err("无效 Bridge 端口".into());
    }
    if std::net::TcpStream::connect_timeout(
        &SocketAddrV4::new(Ipv4Addr::LOCALHOST, port).into(),
        Duration::from_millis(150),
    )
    .is_ok()
    {
        return Err("端口已占用；请关闭已有 Bridge 或配置其他端口".into());
    }
    // Never attach to or terminate a service already using this port.
    let reservation = TcpListener::bind(SocketAddrV4::new(Ipv4Addr::UNSPECIFIED, port))
        .map_err(|_| "端口已占用；请关闭已有 Bridge 或配置其他端口")?;
    let cert = fs::read(&env["PASSPORT_TLS_CERT"]).map_err(|_| "无法读取 TLS 证书")?;
    let cert = reqwest::Certificate::from_pem(&cert).map_err(|_| "无效 TLS 证书")?;
    let client = reqwest::blocking::Client::builder()
        .no_proxy()
        .add_root_certificate(cert)
        .timeout(Duration::from_millis(700))
        .build()
        .map_err(|_| "无法创建安全状态连接")?;
    let mut command = Command::new(&bridge.config.runtime);
    // Do not inherit Passport configuration from Meter's launch environment.
    for (key, _) in std::env::vars_os() {
        let name = key.to_string_lossy();
        if name.starts_with("PASSPORT_")
            || matches!(name.as_ref(), "CODEX_BIN" | "CODEX_DESKTOP_IPC_PATH")
        {
            command.env_remove(key);
        }
    }
    command
        .arg(&bridge.config.script)
        .args(["--lan", "--desktop"])
        .envs(env)
        .env("PASSPORT_HOST", "0.0.0.0")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    drop(reservation);
    bridge.child = Some(
        command
            .spawn()
            .map_err(|_| "无法启动 Bridge；请检查 Node 运行时与脚本")?,
    );
    bridge.probe = Some((client, port));
    bridge.status()
}
#[tauri::command]
pub async fn passport_status(
    app: tauri::AppHandle,
    state: State<'_, PassportState>,
) -> Result<Status, String> {
    let state = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || read_status(app, state))
        .await
        .map_err(|_| "Bridge 状态任务失败")?
}
#[tauri::command]
pub async fn passport_configure(
    app: tauri::AppHandle,
    state: State<'_, PassportState>,
    config: Config,
) -> Result<Status, String> {
    let state = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || configure(app, state, config))
        .await
        .map_err(|_| "Bridge 配置任务失败")?
}
#[tauri::command]
pub async fn passport_toggle(
    state: State<'_, PassportState>,
    enabled: bool,
) -> Result<Status, String> {
    let state = Arc::clone(&state.0);
    tauri::async_runtime::spawn_blocking(move || toggle(state, enabled))
        .await
        .map_err(|_| "Bridge 启停任务失败")?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn stop_is_idempotent() {
        let mut b = Bridge::default();
        b.stop().unwrap();
        b.stop().unwrap();
        assert!(!b.status().unwrap().running);
    }
    #[test]
    fn default_never_starts_service() {
        let mut b = Bridge::default();
        let s = b.status().unwrap();
        assert!(!s.running && !s.connected);
    }
    #[cfg(unix)]
    #[test]
    fn stops_owned_process_and_detects_exit() {
        use std::os::unix::process::CommandExt;
        let child = Command::new("sleep")
            .arg("30")
            .process_group(0)
            .spawn()
            .unwrap();
        let mut b = Bridge {
            child: Some(child),
            config: Config::default(),
            probe: None,
        };
        assert!(b.status().unwrap().running);
        b.stop().unwrap();
        assert!(!b.status().unwrap().running);
        b.child = Some(Command::new("true").spawn().unwrap());
        b.child.as_mut().unwrap().wait().unwrap();
        assert!(!b.status().unwrap().running);
        assert!(b.probe.is_none());
    }
    #[test]
    fn occupied_port_remains_owned_by_existing_listener() {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        assert!(std::net::TcpStream::connect_timeout(
            &SocketAddrV4::new(Ipv4Addr::LOCALHOST, port).into(),
            Duration::from_millis(150)
        )
        .is_ok());
        assert!(listener.local_addr().is_ok());
    }
    #[cfg(unix)]
    #[test]
    fn isolated_tls_lifecycle() {
        let root = std::env::temp_dir().join(format!("meter-bridge-test-{}", std::process::id()));
        fs::create_dir_all(&root).unwrap();
        let cert = root.join("cert.pem");
        let key = root.join("key.pem");
        assert!(Command::new("openssl")
            .args([
                "req",
                "-x509",
                "-newkey",
                "rsa:2048",
                "-nodes",
                "-days",
                "1",
                "-subj",
                "/CN=localhost",
                "-addext",
                "subjectAltName=IP:127.0.0.1",
                "-addext",
                "basicConstraints=critical,CA:FALSE",
                "-keyout"
            ])
            .arg(&key)
            .arg("-out")
            .arg(&cert)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success());
        let runtime = Command::new("node")
            .args(["-p", "process.execPath"])
            .output()
            .unwrap();
        assert!(runtime.status.success());
        let script = root.join("server.mjs");
        fs::write(&script, "import https from 'node:https'; import fs from 'node:fs'; https.createServer({cert:fs.readFileSync(process.env.PASSPORT_TLS_CERT),key:fs.readFileSync(process.env.PASSPORT_TLS_KEY)},(req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({connected:true}));}).listen(Number(process.env.PASSPORT_PORT),'0.0.0.0');").unwrap();
        let existing = TcpListener::bind((Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = existing.local_addr().unwrap().port();
        let env_file = root.join("environment.json");
        fs::write(&env_file, serde_json::to_vec(&serde_json::json!({
            "PASSPORT_TOKEN": "a".repeat(32), "PASSPORT_DEVICE_TOKEN": "b".repeat(32),
            "PASSPORT_TLS_CERT": cert, "PASSPORT_TLS_KEY": key, "PASSPORT_PORT": port.to_string()
        })).unwrap()).unwrap();
        let state = Arc::new(Mutex::new(Bridge {
            config: Config {
                runtime: String::from_utf8(runtime.stdout).unwrap().trim().into(),
                script: script.to_str().unwrap().into(),
                environment_file: env_file.to_str().unwrap().into(),
            },
            child: None,
            probe: None,
        }));
        assert!(toggle(state.clone(), true).is_err());
        assert!(existing.local_addr().is_ok());
        drop(existing);
        assert!(toggle(state.clone(), true).unwrap().running);
        let mut connected = false;
        for _ in 0..30 {
            if state.lock().unwrap().status().unwrap().connected {
                connected = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        let stopped = toggle(state.clone(), false).unwrap();
        fs::remove_dir_all(root).unwrap();
        assert!(
            connected,
            "certificate-verified health probe did not connect"
        );
        assert!(!stopped.running && !stopped.connected);
        assert!(TcpListener::bind((Ipv4Addr::UNSPECIFIED, port)).is_ok());
    }
    #[test]
    fn malformed_configuration_hides_contents() {
        let p = std::env::temp_dir().join(format!("meter-env-{}.json", std::process::id()));
        fs::write(&p, "private-invalid-value").unwrap();
        let e = environment(p.to_str().unwrap()).unwrap_err();
        fs::remove_file(p).unwrap();
        assert!(!e.contains("private-invalid-value"));
    }
}
