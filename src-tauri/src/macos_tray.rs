use objc2::{
    define_class, msg_send, rc::Retained, runtime::AnyObject, sel, DefinedClass, MainThreadOnly,
};
use objc2_app_kit::{NSApplication, NSEventMask, NSEventType, NSMenu, NSStatusItem};
use objc2_foundation::{MainThreadMarker, NSObject};
use std::cell::RefCell;
use tauri::{tray::TrayIcon, Manager, PhysicalPosition};

struct TargetState {
    app: tauri::AppHandle,
    status: Retained<NSStatusItem>,
    menu: Retained<NSMenu>,
}
define_class!(
    #[unsafe(super(NSObject))]
    #[thread_kind = MainThreadOnly]
    #[ivars = TargetState]
    struct MeterStatusTarget;
    impl MeterStatusTarget {
        #[unsafe(method(activate:))]
        fn activate(&self, _sender: Option<&AnyObject>) {
            let mtm = MainThreadMarker::from(self);
            let state = self.ivars();
            let event = NSApplication::sharedApplication(mtm).currentEvent();
            if event.is_some_and(|e| e.r#type() == NSEventType::RightMouseUp) {
                super::panel_trace("native right click");
                #[allow(deprecated)]
                state.status.popUpStatusItemMenu(&state.menu);
                return;
            }
            super::panel_trace("native left click");
            if let Some(tray) = state.app.tray_by_id("usage") {
                if let Ok(Some(rect)) = tray.rect() {
                    if let Some(window) = state.app.get_webview_window("main") {
                        let scale = window.scale_factor().unwrap_or(1.0);
                        let point = rect.position.to_physical::<f64>(scale);
                        let size = rect.size.to_physical::<f64>(scale);
                        if let Ok(mut anchor) = state.app.state::<super::TrayAnchorState>().0.lock() {
                            *anchor = Some(super::TrayAnchor { click: PhysicalPosition::new(point.x + size.width / 2.0, point.y + size.height / 2.0), rect });
                        }
                    }
                }
            }
            if let Err(error) = super::show_main_window(&state.app) { super::panel_trace(&format!("native open error: {error}")); }
        }
    }
);
thread_local! { static TARGET: RefCell<Option<Retained<MeterStatusTarget>>> = const { RefCell::new(None) }; }

pub fn install(tray: &TrayIcon) -> Result<(), String> {
    let app = tray.app_handle().clone();
    tray.with_inner_tray_icon(move |inner| {
        let mtm = MainThreadMarker::new().ok_or("Tray setup requires the main thread")?;
        let status = inner
            .ns_status_item()
            .ok_or("Native status item unavailable")?;
        let menu = status.menu(mtm).ok_or("Native menu unavailable")?;
        let button = status
            .button(mtm)
            .ok_or("Native status button unavailable")?;
        // AppKit's automatic menu tracking intercepts left clicks on macOS 27.
        // Replace the library overlay with a native target/action and route each button explicitly.
        for child in button.subviews() {
            child.removeFromSuperview();
        }
        status.setMenu(None);
        let allocated = MeterStatusTarget::alloc(mtm).set_ivars(TargetState { app, status, menu });
        let target: Retained<MeterStatusTarget> = unsafe { msg_send![super(allocated), init] };
        unsafe {
            button.setTarget(Some(&target));
            button.setAction(Some(sel!(activate:)));
        }
        button.sendActionOn(NSEventMask::LeftMouseUp | NSEventMask::RightMouseUp);
        TARGET.with(|slot| *slot.borrow_mut() = Some(target));
        Ok::<(), String>(())
    })
    .map_err(|error| error.to_string())?
}
