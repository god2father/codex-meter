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
use tauri_plugin_autostart::MacosLauncher;

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
fn runtime_platform() -> &'static str {
    std::env::consts::OS
}

#[tauri::command]
fn update_tray_icon(
    app: tauri::AppHandle,
    rgba: Vec<u8>,
    width: u32,
    height: u32,
    title: Option<String>,
    tooltip: String,
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
        .map_err(|error| error.to_string())?;
    tray.set_tooltip(Some(tooltip))
        .map_err(|error| error.to_string())?;
    tray.set_title(title.as_deref())
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
    if !(280..=480).contains(&width) || !(180..=800).contains(&height) {
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
    #[cfg(target_os = "macos")]
    {
        neutral_icon_macos()
    }
    #[cfg(not(target_os = "macos"))]
    {
        neutral_icon_windows()
    }
}

#[cfg(not(target_os = "macos"))]
fn neutral_icon_windows() -> Image<'static> {
    let width = 64usize;
    let height = 64usize;
    let mut rgba = glass_icon_base(width, height, 1, 1, 62, 62, 15);
    paint_neutral_cat(&mut rgba, width, 32, 36, 29, 25);
    Image::new_owned(rgba, width as u32, height as u32)
}

#[cfg(target_os = "macos")]
fn neutral_icon_macos() -> Image<'static> {
    let width = 104usize;
    let height = 48usize;
    let mut rgba = vec![0u8; width * height * 4];
    paint_neutral_cat(&mut rgba, width, 24, 27, 18, 14);
    for y in 37..46 {
        for x in 54..102 {
            if inside_rounded_rect(x, y, 54, 37, 48, 9, 4) {
                set_pixel(&mut rgba, width, x, y, [37, 57, 72, 110]);
            }
            if inside_rounded_rect(x, y, 56, 39, 13, 5, 2) {
                set_pixel(&mut rgba, width, x, y, [112, 143, 168, 255]);
            }
        }
    }
    Image::new_owned(rgba, width as u32, height as u32)
}

#[cfg(not(target_os = "macos"))]
fn glass_icon_base(
    width: usize,
    height: usize,
    left: usize,
    top: usize,
    glass_width: usize,
    glass_height: usize,
    radius: usize,
) -> Vec<u8> {
    let mut rgba = vec![0u8; width * height * 4];
    for y in 0..height {
        for x in 0..width {
            let pixel = if inside_rounded_rect(x, y, left, top, glass_width, glass_height, radius) {
                let light = ((top + glass_height).saturating_sub(y) * 22 / glass_height) as u8;
                [10 + light / 3, 26 + light / 2, 40 + light, 248]
            } else {
                [0, 0, 0, 0]
            };
            set_pixel(&mut rgba, width, x, y, pixel);
        }
    }
    rgba
}

fn paint_neutral_cat(
    rgba: &mut [u8],
    row_width: usize,
    center_x: i32,
    center_y: i32,
    radius_x: i32,
    radius_y: i32,
) {
    let left = (center_x - radius_x).max(0) as usize;
    let right = (center_x + radius_x).max(0) as usize;
    let top = (center_y - radius_y - 10).max(0) as usize;
    let bottom = (center_y + radius_y).max(0) as usize;
    let left_ear = (
        (center_x - radius_x + 2, center_y - radius_y + 5),
        (center_x - radius_x / 2, center_y - radius_y - 9),
        (center_x - 2, center_y - radius_y + 3),
    );
    let right_ear = (
        (center_x + 2, center_y - radius_y + 3),
        (center_x + radius_x / 2, center_y - radius_y - 9),
        (center_x + radius_x - 2, center_y - radius_y + 5),
    );
    let contains = |x: usize, y: usize| {
        inside_ellipse(x, y, center_x, center_y, radius_x, radius_y)
            || inside_triangle(x, y, left_ear.0, left_ear.1, left_ear.2)
            || inside_triangle(x, y, right_ear.0, right_ear.1, right_ear.2)
    };
    for y in top..=bottom {
        for x in left..=right {
            if contains(x, y) {
                let boundary = !contains(x.saturating_sub(1), y)
                    || !contains(x + 1, y)
                    || !contains(x, y.saturating_sub(1))
                    || !contains(x, y + 1);
                let color = if boundary {
                    [63, 43, 32, 255]
                } else {
                    let warmth = ((bottom.saturating_sub(y)) * 24 / (bottom - top).max(1)) as u8;
                    [164 + warmth / 2, 113 + warmth / 2, 73 + warmth / 3, 255]
                };
                set_pixel(rgba, row_width, x, y, color);
            }
        }
    }

    let left_inner_ear = (
        (center_x - radius_x + 5, center_y - radius_y + 5),
        (center_x - radius_x / 2, center_y - radius_y - 4),
        (center_x - 6, center_y - radius_y + 4),
    );
    let right_inner_ear = (
        (center_x + 6, center_y - radius_y + 4),
        (center_x + radius_x / 2, center_y - radius_y - 4),
        (center_x + radius_x - 5, center_y - radius_y + 5),
    );
    for y in top..=bottom {
        for x in left..=right {
            if inside_triangle(x, y, left_inner_ear.0, left_inner_ear.1, left_inner_ear.2)
                || inside_triangle(
                    x,
                    y,
                    right_inner_ear.0,
                    right_inner_ear.1,
                    right_inner_ear.2,
                )
            {
                set_pixel(rgba, row_width, x, y, [238, 165, 161, 255]);
            }
        }
    }

    for y in top..=bottom {
        for x in left..=right {
            let blaze = inside_ellipse(
                x,
                y,
                center_x,
                center_y - radius_y / 4,
                (radius_x / 5).max(3),
                (radius_y * 3 / 4).max(5),
            );
            let muzzle = inside_ellipse(
                x,
                y,
                center_x - radius_x / 5,
                center_y + radius_y / 3,
                (radius_x * 2 / 5).max(5),
                (radius_y / 3).max(4),
            ) || inside_ellipse(
                x,
                y,
                center_x + radius_x / 5,
                center_y + radius_y / 3,
                (radius_x * 2 / 5).max(5),
                (radius_y / 3).max(4),
            );
            if blaze || muzzle {
                set_pixel(rgba, row_width, x, y, [248, 232, 219, 255]);
            }
        }
    }

    let face_top = center_y - radius_y;
    for (offset, lean) in [(-radius_x / 3, 1), (0, 0), (radius_x / 3, -1)] {
        for step in 2..=(radius_y / 2).max(3) {
            let stripe_x = center_x + offset + lean * step / 4;
            let stripe_y = face_top + step;
            for x in (stripe_x - 1).max(0)..=stripe_x + 1 {
                set_pixel(
                    rgba,
                    row_width,
                    x as usize,
                    stripe_y.max(0) as usize,
                    [67, 43, 28, 255],
                );
            }
        }
    }

    let eye_radius_x = (radius_x * 3 / 10).max(5);
    let eye_radius_y = (radius_y * 3 / 10).max(4);
    let eye_y = center_y - radius_y / 7;
    for center in [center_x - radius_x / 3, center_x + radius_x / 3] {
        let eye_x = center.max(0) as usize;
        let eye_y = eye_y.max(0) as usize;
        for y in eye_y.saturating_sub(eye_radius_y as usize)..=eye_y + eye_radius_y as usize {
            for x in eye_x.saturating_sub(eye_radius_x as usize)..=eye_x + eye_radius_x as usize {
                if inside_ellipse(x, y, center, eye_y as i32, eye_radius_x, eye_radius_y) {
                    set_pixel(rgba, row_width, x, y, [46, 31, 24, 255]);
                }
            }
        }
        for y in
            eye_y.saturating_sub((eye_radius_y - 1) as usize)..=eye_y + (eye_radius_y - 1) as usize
        {
            for x in eye_x.saturating_sub((eye_radius_x - 1) as usize)
                ..=eye_x + (eye_radius_x - 1) as usize
            {
                if inside_ellipse(
                    x,
                    y,
                    center,
                    eye_y as i32,
                    eye_radius_x - 1,
                    eye_radius_y - 1,
                ) {
                    set_pixel(rgba, row_width, x, y, [235, 157, 35, 255]);
                }
            }
        }
        for y in
            eye_y.saturating_sub((eye_radius_y - 1) as usize)..=eye_y + (eye_radius_y - 1) as usize
        {
            for x in eye_x.saturating_sub(1)..=eye_x + 1 {
                if inside_ellipse(x, y, center, eye_y as i32, 2, eye_radius_y - 1) {
                    set_pixel(rgba, row_width, x, y, [30, 22, 18, 255]);
                }
            }
        }
        set_pixel(
            rgba,
            row_width,
            eye_x.saturating_sub(1),
            eye_y.saturating_sub(1),
            [255, 250, 230, 255],
        );
    }

    let nose_y = (center_y + radius_y / 4).max(0) as usize;
    let mouth_x = center_x.max(0) as usize;
    for y in nose_y.saturating_sub(1)..=nose_y + 1 {
        for x in mouth_x.saturating_sub(2)..=mouth_x + 2 {
            set_pixel(rgba, row_width, x, y, [171, 109, 102, 255]);
        }
    }
    let mouth_y = nose_y + 3;
    for &(x, y) in &[
        (mouth_x, nose_y + 2),
        (mouth_x, mouth_y),
        (mouth_x.saturating_sub(3), mouth_y + 2),
        (mouth_x.saturating_sub(2), mouth_y + 1),
        (mouth_x + 2, mouth_y + 1),
        (mouth_x + 3, mouth_y + 2),
    ] {
        set_pixel(rgba, row_width, x, y, [53, 43, 42, 255]);
    }
}

fn set_pixel(rgba: &mut [u8], size: usize, x: usize, y: usize, color: [u8; 4]) {
    let offset = (y * size + x) * 4;
    rgba[offset..offset + 4].copy_from_slice(&color);
}

fn inside_ellipse(
    x: usize,
    y: usize,
    center_x: i32,
    center_y: i32,
    radius_x: i32,
    radius_y: i32,
) -> bool {
    let dx = (x as i32 - center_x) as f32 / radius_x as f32;
    let dy = (y as i32 - center_y) as f32 / radius_y as f32;
    dx * dx + dy * dy <= 1.0
}

fn inside_triangle(x: usize, y: usize, a: (i32, i32), b: (i32, i32), c: (i32, i32)) -> bool {
    let point = (x as i32, y as i32);
    let sign = |p1: (i32, i32), p2: (i32, i32), p3: (i32, i32)| {
        (p1.0 - p3.0) * (p2.1 - p3.1) - (p2.0 - p3.0) * (p1.1 - p3.1)
    };
    let d1 = sign(point, a, b);
    let d2 = sign(point, b, c);
    let d3 = sign(point, c, a);
    !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))
}

fn inside_rounded_rect(
    x: usize,
    y: usize,
    left: usize,
    top: usize,
    width: usize,
    height: usize,
    radius: usize,
) -> bool {
    if x < left || y < top || x >= left + width || y >= top + height {
        return false;
    }
    let inner_left = left + radius;
    let inner_right = left + width - radius - 1;
    let inner_top = top + radius;
    let inner_bottom = top + height - radius - 1;
    if (inner_left..=inner_right).contains(&x) || (inner_top..=inner_bottom).contains(&y) {
        return true;
    }
    let center_x = if x < inner_left {
        inner_left
    } else {
        inner_right
    };
    let center_y = if y < inner_top {
        inner_top
    } else {
        inner_bottom
    };
    let dx = x.abs_diff(center_x);
    let dy = y.abs_diff(center_y);
    dx * dx + dy * dy <= radius * radius
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            let _ = show_main_window(app);
        }))
        .plugin(tauri_plugin_autostart::init(
            MacosLauncher::LaunchAgent,
            None,
        ))
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
            runtime_platform,
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
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.hide();
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
