mod codex;

use codex::{CodexService, UsageSnapshot};
use serde::Serialize;
use std::sync::{Arc, Mutex};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Emitter, LogicalSize, Manager, PhysicalPosition, Rect, RunEvent, State, WindowEvent,
};

struct AppState(Arc<Mutex<CodexService>>);

#[derive(Clone)]
struct TrayAnchor {
    click: PhysicalPosition<f64>,
    rect: Rect,
}

struct TrayAnchorState(Mutex<Option<TrayAnchor>>);

fn preview_mode() -> bool {
    cfg!(debug_assertions) && std::env::var_os("CODEX_METER_PREVIEW").is_some()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
enum PanelEdge {
    Top,
    Bottom,
    Left,
    Right,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PanelPosition {
    anchor_x: f64,
    anchor_y: f64,
    edge: PanelEdge,
}

#[tauri::command]
async fn refresh_usage(state: State<'_, AppState>) -> Result<UsageSnapshot, String> {
    let service = Arc::clone(&state.0);
    let snapshot = match tauri::async_runtime::spawn_blocking(move || match service.lock() {
        Ok(mut service) => service.refresh(),
        Err(_) => UsageSnapshot::service_error("Usage service is unavailable"),
    })
    .await
    {
        Ok(snapshot) => snapshot,
        Err(_) => UsageSnapshot::service_error("Usage refresh task stopped unexpectedly"),
    };
    Ok(snapshot)
}

#[tauri::command]
fn update_tray_icon(
    app: tauri::AppHandle,
    rgba: Vec<u8>,
    width: u32,
    height: u32,
) -> Result<(), String> {
    if width == 0 || height == 0 || width > 128 || height > 128 {
        return Err("Tray icon dimensions must be between 1 and 128 pixels".into());
    }
    let expected = width as usize * height as usize * 4;
    if rgba.len() != expected {
        return Err(format!(
            "Expected {expected} RGBA bytes, got {}",
            rgba.len()
        ));
    }
    let tray = app.tray_by_id("usage").ok_or("Tray icon is not ready")?;
    tray.set_icon(Some(Image::new_owned(rgba, width, height)))
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn open_settings(app: tauri::AppHandle) -> Result<(), String> {
    show_main_window(&app)?;
    app.emit("settings://open", ())
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}

#[tauri::command]
fn hide_panel(app: tauri::AppHandle) -> Result<(), String> {
    app.get_webview_window("main")
        .ok_or("Main window is unavailable")?
        .hide()
        .map_err(|error| error.to_string())
}

#[tauri::command]
fn resize_panel(app: tauri::AppHandle, width: u32, height: u32) -> Result<(), String> {
    if !(280..=480).contains(&width) || !(180..=600).contains(&height) {
        return Err("Panel dimensions are outside the supported range".into());
    }
    let window = app
        .get_webview_window("main")
        .ok_or("Main window is unavailable")?;
    window
        .set_size(LogicalSize::new(width as f64, height as f64))
        .map_err(|error| error.to_string())?;

    let anchor = app
        .state::<TrayAnchorState>()
        .0
        .lock()
        .ok()
        .and_then(|value| value.clone());
    if let Some(anchor) = anchor {
        position_near_tray(&app, &window, &anchor);
    }
    Ok(())
}

fn show_main_window(app: &tauri::AppHandle) -> Result<(), String> {
    let window = app
        .get_webview_window("main")
        .ok_or("Main window is unavailable")?;
    window.show().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

fn toggle_main_window(app: &tauri::AppHandle, anchor: Option<TrayAnchor>) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    if window.is_visible().unwrap_or(false) {
        let _ = window.hide();
    } else {
        if let Some(anchor) = anchor {
            position_near_tray(app, &window, &anchor);
        }
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn position_near_tray(app: &tauri::AppHandle, window: &tauri::WebviewWindow, tray: &TrayAnchor) {
    let monitor = app
        .monitor_from_point(tray.click.x, tray.click.y)
        .ok()
        .flatten()
        .or_else(|| app.primary_monitor().ok().flatten());
    let (Some(monitor), Ok(window_size)) = (monitor, window.outer_size()) else {
        return;
    };

    let scale = monitor.scale_factor();
    let anchor = tray.rect.position.to_physical::<i32>(scale);
    let anchor_size = tray.rect.size.to_physical::<u32>(scale);
    let work = monitor.work_area();
    let anchor_center_x = anchor.x as i64 + anchor_size.width as i64 / 2;
    let anchor_center_y = anchor.y as i64 + anchor_size.height as i64 / 2;
    let work_left = work.position.x as i64;
    let work_top = work.position.y as i64;
    let work_right = work_left + work.size.width as i64;
    let work_bottom = work_top + work.size.height as i64;
    let edge = nearest_edge(
        anchor_center_x,
        anchor_center_y,
        work_left,
        work_top,
        work_right,
        work_bottom,
    );

    let (mut x, mut y) = match edge {
        PanelEdge::Top => (anchor_center_x - window_size.width as i64 / 2, work_top),
        PanelEdge::Bottom => (
            anchor_center_x - window_size.width as i64 / 2,
            work_bottom - window_size.height as i64,
        ),
        PanelEdge::Left => (work_left, anchor_center_y - window_size.height as i64 / 2),
        PanelEdge::Right => (
            work_right - window_size.width as i64,
            anchor_center_y - window_size.height as i64 / 2,
        ),
    };

    let max_x = (work_right - window_size.width as i64).max(work_left);
    let max_y = (work_bottom - window_size.height as i64).max(work_top);
    x = x.clamp(work_left, max_x);
    y = y.clamp(work_top, max_y);
    let _ = window.set_position(PhysicalPosition::new(x as i32, y as i32));

    let window_width = window_size.width as f64 / scale;
    let window_height = window_size.height as f64 / scale;
    let anchor_x = ((anchor_center_x - x) as f64 / scale).clamp(18.0, window_width - 18.0);
    let anchor_y = ((anchor_center_y - y) as f64 / scale).clamp(18.0, window_height - 18.0);
    let _ = app.emit_to(
        "main",
        "panel://positioned",
        PanelPosition {
            anchor_x,
            anchor_y,
            edge,
        },
    );
}

fn nearest_edge(x: i64, y: i64, left: i64, top: i64, right: i64, bottom: i64) -> PanelEdge {
    [
        (y.abs_diff(top), PanelEdge::Top),
        (y.abs_diff(bottom), PanelEdge::Bottom),
        (x.abs_diff(left), PanelEdge::Left),
        (x.abs_diff(right), PanelEdge::Right),
    ]
    .into_iter()
    .min_by_key(|(distance, _)| *distance)
    .map(|(_, edge)| edge)
    .unwrap_or(PanelEdge::Bottom)
}

fn neutral_icon() -> Image<'static> {
    let size = 32usize;
    let mut rgba = vec![0u8; size * size * 4];
    for y in 0..size {
        for x in 0..size {
            let dx = x as f32 - 15.5;
            let dy = y as f32 - 15.5;
            let radius = (dx * dx + dy * dy).sqrt();
            if (11.0..=14.0).contains(&radius) {
                let offset = (y * size + x) * 4;
                rgba[offset..offset + 4].copy_from_slice(&[120, 130, 145, 255]);
            }
        }
    }
    Image::new_owned(rgba, size as u32, size as u32)
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = show_main_window(app);
        }))
        .manage(AppState(Arc::new(Mutex::new(CodexService::new()))))
        .manage(TrayAnchorState(Mutex::new(None)))
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.handle()
                .set_activation_policy(tauri::ActivationPolicy::Accessory)?;

            let show = MenuItem::with_id(app, "show", "显示用量", true, None::<&str>)?;
            let refresh = MenuItem::with_id(app, "refresh", "刷新", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &refresh, &quit])?;

            TrayIconBuilder::with_id("usage")
                .icon(neutral_icon())
                .tooltip("Codex Meter")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id().as_ref() {
                    "show" => {
                        let anchor = app
                            .state::<TrayAnchorState>()
                            .0
                            .lock()
                            .ok()
                            .and_then(|value| value.clone());
                        toggle_main_window(app, anchor);
                    }
                    "refresh" => {
                        let _ = app.emit("usage://refresh-requested", ());
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let TrayIconEvent::Click {
                        position,
                        rect,
                        button_state: MouseButtonState::Up,
                        button,
                        ..
                    } = event
                    {
                        let anchor = TrayAnchor {
                            click: position,
                            rect,
                        };
                        if let Ok(mut stored) =
                            tray.app_handle().state::<TrayAnchorState>().0.lock()
                        {
                            *stored = Some(anchor.clone());
                        }
                        if button == MouseButton::Left {
                            toggle_main_window(tray.app_handle(), Some(anchor));
                        }
                    }
                })
                .build(app)?;

            if preview_mode() {
                if let Some(window) = app.get_webview_window("main") {
                    window.show()?;
                    window.set_focus()?;
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            refresh_usage,
            update_tray_icon,
            resize_panel,
            hide_panel,
            open_settings,
            quit_app
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Codex Meter");

    app.run(|app, event| {
        if let RunEvent::WindowEvent { label, event, .. } = event {
            if label == "main" {
                match event {
                    WindowEvent::CloseRequested { api, .. } => {
                        api.prevent_close();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.hide();
                        }
                    }
                    WindowEvent::Focused(false) => {
                        if !preview_mode() {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.hide();
                            }
                        }
                    }
                    _ => {}
                }
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::{nearest_edge, PanelEdge};

    #[test]
    fn detects_each_taskbar_edge() {
        let bounds = (0, 40, 1920, 1040);
        assert_eq!(
            nearest_edge(960, 20, bounds.0, bounds.1, bounds.2, bounds.3),
            PanelEdge::Top
        );
        assert_eq!(
            nearest_edge(960, 1060, bounds.0, bounds.1, bounds.2, bounds.3),
            PanelEdge::Bottom
        );
        assert_eq!(
            nearest_edge(-20, 540, bounds.0, bounds.1, bounds.2, bounds.3),
            PanelEdge::Left
        );
        assert_eq!(
            nearest_edge(1940, 540, bounds.0, bounds.1, bounds.2, bounds.3),
            PanelEdge::Right
        );
    }
}
