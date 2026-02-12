use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Emitter, Manager,
};

/// 创建系统托盘
pub fn create_tray(app: &AppHandle) -> Result<(), String> {
    let show = MenuItem::with_id(app, "show", "显示/隐藏浮窗", true, None::<&str>)
        .map_err(|e| format!("创建菜单项失败: {e}"))?;
    let vad = MenuItem::with_id(app, "vad", "VAD 模式", true, None::<&str>)
        .map_err(|e| format!("创建菜单项失败: {e}"))?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)
        .map_err(|e| format!("创建菜单项失败: {e}"))?;

    let menu = Menu::with_items(app, &[&show, &vad, &quit])
        .map_err(|e| format!("创建菜单失败: {e}"))?;

    TrayIconBuilder::new()
        .tooltip("Logene 语音输入法")
        .menu(&menu)
        .on_menu_event(move |app, event| match event.id.as_ref() {
            "show" => {
                if let Some(window) = app.get_webview_window("main") {
                    if window.is_visible().unwrap_or(false) {
                        let _ = window.hide();
                    } else {
                        let _ = window.show();
                        let _ = window.set_focus();
                    }
                }
            }
            "vad" => {
                // 通过前端事件触发 VAD 切换
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.emit("toggle-vad", ());
                }
            }
            "quit" => {
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.show();
                    let _ = window.set_focus();
                }
            }
        })
        .build(app)
        .map_err(|e| format!("创建托盘失败: {e}"))?;

    Ok(())
}
