use super::{environment, Config};
use std::{
    collections::BTreeMap,
    fs,
    net::{Ipv4Addr, TcpListener},
    path::{Path, PathBuf},
    process::Command,
};
use tauri::Manager;

fn private_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|_| "无法安全创建连接文件")?;
    file.write_all(bytes)
        .map_err(|_| "无法保存连接文件".to_owned())
}
fn token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "无法生成安全连接凭据")?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
fn runtime_name() -> &'static str {
    if cfg!(target_os = "windows") {
        "node.exe"
    } else {
        "node"
    }
}
fn runtime_candidates() -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|p| p.join(runtime_name())));
    }
    #[cfg(target_os = "macos")]
    candidates.extend([
        PathBuf::from("/opt/homebrew/bin/node"),
        PathBuf::from("/usr/local/bin/node"),
    ]);
    if let Some(home) = std::env::var_os("HOME") {
        let versions = PathBuf::from(home).join(".nvm/versions/node");
        if let Ok(entries) = fs::read_dir(versions) {
            let mut versions: Vec<_> = entries.filter_map(Result::ok).map(|p| p.path()).collect();
            versions.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
            candidates.extend(
                versions
                    .into_iter()
                    .map(|p| p.join("bin").join(runtime_name())),
            );
        }
    }
    #[cfg(target_os = "windows")]
    for variable in ["ProgramFiles", "LOCALAPPDATA", "NVM_SYMLINK"] {
        if let Some(root) = std::env::var_os(variable) {
            let root = PathBuf::from(root);
            candidates.extend([root.join("nodejs/node.exe"), root.join("node.exe")]);
        }
    }
    candidates
}
fn supported_version(version: &str) -> bool {
    let Some(version) = version.trim().strip_prefix('v') else {
        return false;
    };
    let parts: Vec<_> = version.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        && parts[0].parse::<u32>().is_ok_and(|major| major >= 22)
}
fn supported_runtime(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }
    let mut command = Command::new(path);
    command.arg("--version");
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    command.output().is_ok_and(|out| {
        out.status.success() && supported_version(&String::from_utf8_lossy(&out.stdout))
    })
}
pub fn runtime() -> Result<PathBuf, String> {
    runtime_candidates()
        .into_iter()
        .find(|p| supported_runtime(p))
        .ok_or("未找到 Node.js 22 或更新版本，请安装后重试".into())
}
fn resources(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path()
        .resource_dir()
        .map_err(|_| "无法定位内置连接服务")?
        .join("resources");
    if path.join("bridge/server.mjs").is_file() {
        return Ok(path);
    }
    #[cfg(debug_assertions)]
    {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
        if path.join("bridge/server.mjs").is_file() {
            return Ok(path);
        }
    }
    Err("此版本缺少内置连接服务，请安装完整应用".into())
}
fn addresses(runtime: &Path) -> Result<Vec<String>, String> {
    // Node's OS API enumerates interfaces locally; no network request is sent.
    let output = Command::new(runtime).args(["-e", "const n=require('node:os').networkInterfaces(); console.log(JSON.stringify(Object.entries(n).sort(([a],[b])=>(a==='en0'?-1:b==='en0'?1:a.localeCompare(b))).filter(([name])=>!/^utun|^tun|^bridge|^docker|^veth/.test(name)).flatMap(([,v])=>v.filter(x=>x.family==='IPv4'&&!x.internal).map(x=>x.address))))"]).output().map_err(|_| "无法检测电脑网络")?;
    if !output.status.success() {
        return Err("无法检测电脑网络".into());
    }
    let list: Vec<String> =
        serde_json::from_slice(&output.stdout).map_err(|_| "无法读取电脑网络")?;
    Ok(list
        .into_iter()
        .filter(|s| {
            s.parse::<Ipv4Addr>()
                .is_ok_and(|ip| ip.is_private() && ip != Ipv4Addr::new(192, 168, 4, 1))
        })
        .collect())
}
pub fn existing(app: &tauri::AppHandle) -> Result<Option<Config>, String> {
    let env = app
        .path()
        .app_config_dir()
        .map_err(|_| "无法定位连接配置")?
        .join("managed-bridge/environment.json");
    if !env.is_file() {
        return Ok(None);
    }
    let resource = resources(app)?;
    Ok(Some(Config {
        runtime: runtime()?.to_string_lossy().into(),
        script: resource.join("bridge/server.mjs").to_string_lossy().into(),
        environment_file: env.to_string_lossy().into(),
    }))
}
pub fn prepare(app: &tauri::AppHandle) -> Result<(Config, String), String> {
    let resource = resources(app)?;
    let root = app
        .path()
        .app_config_dir()
        .map_err(|_| "无法定位连接配置")?
        .join("managed-bridge");
    prepare_in(&resource, &root, false)
}
pub fn prepare_binding(app: &tauri::AppHandle) -> Result<(Config, String), String> {
    let resource = resources(app)?;
    let root = app
        .path()
        .app_config_dir()
        .map_err(|_| "无法定位连接配置")?
        .join("managed-bridge");
    prepare_in(&resource, &root, true)
}
fn prepare_in(resource: &Path, root: &Path, renew: bool) -> Result<(Config, String), String> {
    let runtime = runtime()?;
    let script = resource.join("bridge/server.mjs");
    if !script.is_file() {
        return Err("内置连接服务不完整".into());
    }
    let ips = addresses(&runtime)?;
    let address = ips
        .first()
        .ok_or("请先让电脑连接到 Wi-Fi 或局域网")?
        .clone();
    fs::create_dir_all(&root).map_err(|_| "无法创建连接配置")?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&root, fs::Permissions::from_mode(0o700))
            .map_err(|_| "无法保护连接配置")?;
    }
    let env_path = root.join("environment.json");
    if env_path.is_file() {
        let mut env = environment(env_path.to_str().ok_or("无效配置路径")?)?;
        if !env.contains_key("PASSPORT_ENROLLMENT_FILE") {
            env.insert(
                "PASSPORT_ENROLLMENT_FILE".into(),
                root.join("active-enrollment.json").to_string_lossy().into(),
            );
            replace_private(
                &env_path,
                &serde_json::to_vec(&env).map_err(|_| "无法编码连接配置")?,
            )?;
        }
        if env
            .get("PASSPORT_METER_ADDRESSES")
            .is_some_and(|s| s.split(',').any(|ip| ip == address))
        {
            return Ok((
                Config {
                    runtime: runtime.to_string_lossy().into(),
                    script: script.to_string_lossy().into(),
                    environment_file: env_path.to_string_lossy().into(),
                },
                address,
            ));
        }
        // Preserve the device's existing trust identity rather than silently replacing it.
        if !renew {
            return Err("电脑网络地址已改变，请关闭连接后重新绑定设备".into());
        }
    }
    let port = (8766..8796)
        .find(|port| TcpListener::bind((Ipv4Addr::UNSPECIFIED, *port)).is_ok())
        .ok_or("没有可用的连接端口")?;
    let mut names = ips.clone();
    names.extend(["127.0.0.1".into(), "localhost".into()]);
    let rcgen::CertifiedKey { cert, signing_key } =
        rcgen::generate_simple_self_signed(names).map_err(|_| "无法生成电脑连接证书")?;
    let cert_path = root.join(format!("certificate-{}.pem", token()?));
    let key_path = root.join(format!("private-key-{}.pem", token()?));
    // Credentials are committed only after every dependent file has been created.
    private_write(&cert_path, cert.pem().as_bytes())?;
    private_write(&key_path, signing_key.serialize_pem().as_bytes())?;
    let mut env = BTreeMap::from([
        ("PASSPORT_TOKEN".to_owned(), token()?),
        ("PASSPORT_DEVICE_TOKEN".into(), token()?),
        (
            "PASSPORT_TLS_CERT".into(),
            cert_path.to_string_lossy().into(),
        ),
        ("PASSPORT_TLS_KEY".into(), key_path.to_string_lossy().into()),
        ("PASSPORT_PORT".into(), port.to_string()),
        ("PASSPORT_METER_ADDRESSES".into(), ips.join(",")),
        (
            "PASSPORT_ENROLLMENT_FILE".into(),
            root.join("active-enrollment.json").to_string_lossy().into(),
        ),
    ]);
    if let Some(cli) = crate::codex::codex_candidates()
        .into_iter()
        .find(|s| Path::new(s).is_absolute() && Path::new(s).is_file())
    {
        env.insert("CODEX_BIN".into(), cli.clone());
        env.insert("PASSPORT_QUOTA_CLI".into(), cli);
    }
    let staged = root.join(format!("environment-{}.json", token()?));
    private_write(
        &staged,
        &serde_json::to_vec(&env).map_err(|_| "无法编码连接配置")?,
    )?;
    let backup = root.join(format!("previous-environment-{}.json", token()?));
    let previous = env_path.is_file();
    if previous {
        fs::rename(&env_path, &backup).map_err(|_| "无法备份连接配置")?;
    }
    if fs::rename(&staged, &env_path).is_err() {
        if previous {
            let _ = fs::rename(&backup, &env_path);
        }
        return Err("无法保存连接配置".into());
    }
    Ok((
        Config {
            runtime: runtime.to_string_lossy().into(),
            script: script.to_string_lossy().into(),
            environment_file: env_path.to_string_lossy().into(),
        },
        address,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn enrollment_is_private_short_lived_and_replaceable() {
        let resource = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
        let root = std::env::temp_dir().join(format!("meter-enrollment-{}", token().unwrap()));
        let (config, address) = prepare_in(&resource, &root, false).unwrap();
        let first = enrollment(&config, &address).unwrap();
        assert_eq!(first.code.len(), 4);
        assert!(first.code.bytes().all(|b| b.is_ascii_digit()));
        let env = environment(&config.environment_file).unwrap();
        let file = Path::new(&env["PASSPORT_ENROLLMENT_FILE"]);
        let payload: serde_json::Value = serde_json::from_slice(&fs::read(file).unwrap()).unwrap();
        assert_eq!(payload["code"], first.code);
        assert_eq!(payload["pairing"]["token"], env["PASSPORT_DEVICE_TOKEN"]);
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_millis() as u64;
        assert!(first.expires_at > now && first.expires_at <= now + 300000);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(file).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        let previous_session = payload["sessionId"].clone();
        let _ = enrollment(&config, &address).unwrap();
        let fresh: serde_json::Value = serde_json::from_slice(&fs::read(file).unwrap()).unwrap();
        assert_ne!(fresh["sessionId"], previous_session);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn credentials_are_independent_and_url_safe() {
        let first = token().unwrap();
        let second = token().unwrap();
        assert_ne!(first, second);
        assert_eq!(first.len(), 64);
        assert!(first.bytes().all(|b| b.is_ascii_hexdigit()));
    }
    #[test]
    fn secret_file_is_private_and_never_overwritten() {
        let path = std::env::temp_dir().join(format!("meter-private-{}", token().unwrap()));
        private_write(&path, b"test-only-secret").unwrap();
        assert!(private_write(&path, b"replacement").is_err());
        assert_eq!(fs::read(&path).unwrap(), b"test-only-secret");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&path).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        fs::remove_file(path).unwrap();
    }
    #[test]
    fn provisioning_is_repeatable_and_tls_trusted() {
        let resource = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
        let root = std::env::temp_dir().join(format!("meter-provision-{}", token().unwrap()));
        let (first, address) = prepare_in(&resource, &root, false).unwrap();
        let initial = environment(&first.environment_file).unwrap();
        let (second, second_address) = prepare_in(&resource, &root, false).unwrap();
        assert_eq!(first.environment_file, second.environment_file);
        assert_eq!(address, second_address);
        assert_eq!(initial, environment(&second.environment_file).unwrap());
        let pairing = super::super::pairing(&first, &address).unwrap();
        assert!(pairing.ca_pem.len() < 3072);
        assert_eq!(pairing.token, initial["PASSPORT_DEVICE_TOKEN"]);
        assert_ne!(pairing.token, initial["PASSPORT_TOKEN"]);
        // Keep acceptance isolated from the user's Codex process and existing Bridge.
        let mut isolated = initial;
        isolated.insert("PASSPORT_ENROLLMENT_DISCOVERY_PORT".into(), "0".into());
        isolated.remove("PASSPORT_QUOTA_CLI");
        isolated.insert(
            "CODEX_DESKTOP_IPC_PATH".into(),
            root.join("missing-ipc.sock").to_string_lossy().into(),
        );
        fs::write(
            &first.environment_file,
            serde_json::to_vec(&isolated).unwrap(),
        )
        .unwrap();
        let state = std::sync::Arc::new(std::sync::Mutex::new(super::super::Bridge {
            config: first,
            failure: None,
            child: None,
            probe: None,
        }));
        super::super::toggle(state.clone(), true).unwrap();
        let mut ready = false;
        for _ in 0..30 {
            if state
                .lock()
                .unwrap()
                .status()
                .unwrap()
                .message
                .contains("Bridge 已启动")
            {
                ready = true;
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(100));
        }
        state.lock().unwrap().stop().unwrap();
        fs::remove_dir_all(root).unwrap();
        assert!(
            ready,
            "Bundled Bridge must respond through certificate-verified HTTPS"
        );
    }
    #[test]
    fn address_change_requires_rebinding_and_preserves_previous_credentials() {
        let resource = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources");
        let root = std::env::temp_dir().join(format!("meter-rebind-{}", token().unwrap()));
        let (first, _) = prepare_in(&resource, &root, false).unwrap();
        let mut initial = environment(&first.environment_file).unwrap();
        initial.insert("PASSPORT_METER_ADDRESSES".into(), "192.0.2.1".into());
        let before = serde_json::to_vec(&initial).unwrap();
        fs::write(&first.environment_file, &before).unwrap();
        assert!(prepare_in(&resource, &root, false).is_err());
        assert_eq!(fs::read(&first.environment_file).unwrap(), before);
        let (renewed, address) = prepare_in(&resource, &root, true).unwrap();
        let after = environment(&renewed.environment_file).unwrap();
        assert_ne!(
            initial["PASSPORT_DEVICE_TOKEN"],
            after["PASSPORT_DEVICE_TOKEN"]
        );
        assert_ne!(initial["PASSPORT_TLS_CERT"], after["PASSPORT_TLS_CERT"]);
        assert!(root.join(&initial["PASSPORT_TLS_CERT"]).is_file());
        assert!(fs::read_dir(&root)
            .unwrap()
            .filter_map(Result::ok)
            .any(|file| file
                .file_name()
                .to_string_lossy()
                .starts_with("previous-environment-")
                && fs::read(file.path()).unwrap() == before));
        assert!(super::super::pairing(&renewed, &address).is_ok());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn detected_versions_require_supported_node() {
        assert!(supported_version("v22.22.0\n"));
        assert!(supported_version("v24.0.0"));
        for version in ["v20.19.0", "22", "v22", "v22.1.x", "garbage"] {
            assert!(!supported_version(version));
        }
        assert!(!supported_runtime(Path::new(
            "/nonexistent/codex-meter-node"
        )));
    }

    #[test]
    fn local_addresses_come_from_detected_runtime() {
        let runtime = runtime().unwrap();
        let addresses = addresses(&runtime).unwrap();
        assert!(addresses
            .iter()
            .all(|s| s.parse::<Ipv4Addr>().unwrap().is_private()));
    }
}

fn replace_private(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let staged = path.with_file_name(format!("staged-{}.json", token()?));
    private_write(&staged, bytes)?;
    if fs::rename(&staged, path).is_err() {
        let _ = fs::remove_file(staged);
        return Err("无法保存私有连接配置".into());
    }
    Ok(())
}
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Enrollment {
    pub code: String,
    pub expires_at: u64,
}
pub fn enrollment(config: &Config, address: &str) -> Result<Enrollment, String> {
    let env = environment(&config.environment_file)?;
    let file = env
        .get("PASSPORT_ENROLLMENT_FILE")
        .ok_or("请关闭连接后重新绑定设备")?;
    let mut code = String::new();
    while code.len() < 4 {
        let mut byte = [0u8; 1];
        getrandom::fill(&mut byte).map_err(|_| "无法生成绑定码")?;
        if byte[0] < 250 {
            code.push(char::from(b'0' + byte[0] % 10));
        }
    }
    let expires_at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| "系统时间无效")?
        .as_millis() as u64
        + 300000;
    let payload = serde_json::json!({ "code": code, "sessionId": token()?, "expiresAt": expires_at,
        "pairing": super::pairing(config, address)?, "port": env["PASSPORT_PORT"].parse::<u16>().map_err(|_| "无效端口")?,
        "addresses": env["PASSPORT_METER_ADDRESSES"].split(',').collect::<Vec<_>>() });
    replace_private(
        Path::new(file),
        &serde_json::to_vec(&payload).map_err(|_| "无法编码绑定信息")?,
    )?;
    Ok(Enrollment { code, expires_at })
}
