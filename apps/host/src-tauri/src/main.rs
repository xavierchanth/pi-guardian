use std::{sync::Mutex, time::Duration};

use pi_tai_host_lifecycle::{HostLifecycle, QuitRequest, WindowCloseAction};
use pi_tai_host_platform::{ReadinessEndpoint, ReadinessStatus, UnixReadinessEndpoint};
use tauri::{
    Manager, WindowEvent,
    menu::{Menu, MenuItem, PredefinedMenuItem},
    tray::TrayIconBuilder,
};

struct HostAgentState {
    lifecycle: Mutex<HostLifecycle>,
    readiness: Mutex<Option<UnixReadinessEndpoint>>,
}

fn show_diagnostics(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("diagnostics") {
        let _ = window.show();
        let _ = window.set_focus();
    }
}

fn exit_host(app: &tauri::AppHandle) {
    let state = app.state::<HostAgentState>();
    if let Some(mut readiness) = state.readiness.lock().unwrap().take() {
        let _ = readiness.shutdown();
    }
    app.exit(0);
}

fn request_quit(app: &tauri::AppHandle) {
    let state = app.state::<HostAgentState>();
    let decision = state.lifecycle.lock().unwrap().request_quit();
    match decision {
        QuitRequest::QuitNow => exit_host(app),
        QuitRequest::WarnActiveTurns { count } => {
            show_diagnostics(app);
            if let Some(window) = app.get_webview_window("diagnostics") {
                let _ = window.set_title(&format!(
                    "Warning: quitting interrupts {count} active turn(s)"
                ));
            }
            eprintln!(r#"{{"event":"host.quit_warning","activeTurns":{count}}}"#);
        }
    }
}

fn confirm_quit(app: &tauri::AppHandle) {
    let state = app.state::<HostAgentState>();
    if state.lifecycle.lock().unwrap().confirm_quit() {
        exit_host(app);
    }
}

fn main() {
    let result = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            if args.iter().any(|arg| arg == "--proof-request-quit") {
                request_quit(app);
            } else if args.iter().any(|arg| arg == "--proof-confirm-quit") {
                confirm_quit(app);
            } else {
                show_diagnostics(app);
            }
            eprintln!(r#"{{"event":"host.second_launch","action":"delegated"}}"#);
        }))
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let data_dir = app.path().app_local_data_dir()?;
            let readiness = UnixReadinessEndpoint::bind(
                data_dir.join("proof-readiness.sock"),
                ReadinessStatus {
                    status: "ready".into(),
                    pid: std::process::id(),
                    version: env!("CARGO_PKG_VERSION").into(),
                },
            )?;
            eprintln!(
                r#"{{"event":"host.ready","endpoint":"{}"}}"#,
                readiness.address().display()
            );

            let mut lifecycle = HostLifecycle::default();
            let proof_active_turns = std::env::var("PI_TAI_PROOF_ACTIVE_TURNS")
                .ok()
                .and_then(|value| value.parse().ok())
                .unwrap_or(0);
            lifecycle.set_active_turns(proof_active_turns);
            lifecycle.mark_ready();
            app.manage(HostAgentState {
                lifecycle: Mutex::new(lifecycle),
                readiness: Mutex::new(Some(readiness)),
            });

            let health = MenuItem::with_id(
                app,
                "health",
                if proof_active_turns == 0 {
                    "Healthy"
                } else {
                    "Healthy • proof active turn"
                },
                false,
                None::<&str>,
            )?;
            let diagnostics =
                MenuItem::with_id(app, "diagnostics", "Open Diagnostics", true, None::<&str>)?;
            let quit =
                MenuItem::with_id(app, "quit", "Quit Pi-Tai Host Agent", true, None::<&str>)?;
            let confirm_quit_item = MenuItem::with_id(
                app,
                "confirm-quit",
                "Confirm Quit and Interrupt Active Turns",
                true,
                None::<&str>,
            )?;
            let separator = PredefinedMenuItem::separator(app)?;
            let menu = Menu::with_items(
                app,
                &[&health, &diagnostics, &separator, &quit, &confirm_quit_item],
            )?;

            let mut tray = TrayIconBuilder::with_id("pi-tai-host")
                .menu(&menu)
                .tooltip("Pi-Tai Host Agent");
            if let Some(icon) = app.default_window_icon() {
                tray = tray.icon(icon.clone());
            }
            tray.on_menu_event(|app, event| match event.id().as_ref() {
                "diagnostics" => show_diagnostics(app),
                "quit" => request_quit(app),
                "confirm-quit" => confirm_quit(app),
                _ => {}
            })
            .build(app)?;

            if let Some(delay) = std::env::var("PI_TAI_PROOF_AUTO_CLOSE_MS")
                .ok()
                .and_then(|value| value.parse::<u64>().ok())
            {
                let window = app
                    .get_webview_window("diagnostics")
                    .expect("configured diagnostics window");
                window.show()?;
                std::thread::spawn(move || {
                    std::thread::sleep(Duration::from_millis(delay));
                    let _ = window.close();
                });
            }

            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                let state = window.state::<HostAgentState>();
                let action = state.lifecycle.lock().unwrap().window_close_requested();
                if action == WindowCloseAction::HideWindowKeepHostRunning {
                    api.prevent_close();
                    let _ = window.hide();
                    eprintln!(r#"{{"event":"host.window_hidden","hostAlive":true}}"#);
                }
            }
        })
        .run(tauri::generate_context!());

    if let Err(error) = result {
        eprintln!(r#"{{"event":"host.fatal","message":"{error}"}}"#);
        std::process::exit(1);
    }
}
