mod audio;
mod asr;
mod commands;
mod config;
mod input_sim;
mod tray;
mod vad;
mod voice_commands;

use audio::AudioState;
use commands::AppState;
use config::load_config;
use vad::VadController;
use voice_commands::VoiceCommandMatcher;
use std::sync::Mutex;
use tauri::{Emitter, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    env_logger::init();

    let config = load_config().unwrap_or_else(|e| {
        log::error!("加载配置失败: {e}，使用默认配置");
        panic!("配置加载失败: {e}");
    });

    let matcher = VoiceCommandMatcher::new(config.voice_commands.clone());

    let mut audio_state = AudioState::new();
    if let Err(e) = audio_state.start_audio_thread() {
        log::error!("启动音频线程失败: {e}");
    }

    let app_state = AppState {
        audio: Mutex::new(audio_state),
        config: Mutex::new(config),
        matcher: Mutex::new(matcher),
        vad_controller: Mutex::new(VadController::new()),
    };

    tauri::Builder::default()
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    let _ = shortcut; // 目前只注册一个热键
                    match event.state() {
                        ShortcutState::Pressed => {
                            let state = app.state::<AppState>();
                            if let Err(e) = state.audio.lock().unwrap().start_recording() {
                                log::error!("热键录音启动失败: {e}");
                            }
                            let _ = app.emit("hotkey-state", "recording");
                        }
                        ShortcutState::Released => {
                            let app_handle = app.clone();
                            // 异步处理识别
                            tauri::async_runtime::spawn(async move {
                                let state = app_handle.state::<AppState>();
                                let (wav_bytes, server_url, asr_config_id, use_clipboard) = {
                                    let audio = state.audio.lock().unwrap();
                                    let _ = audio.stop_recording();
                                    std::thread::sleep(std::time::Duration::from_millis(100));
                                    let wav = match audio.encode_wav() {
                                        Ok(w) => w,
                                        Err(e) => {
                                            log::error!("WAV 编码失败: {e}");
                                            let _ = app_handle.emit("hotkey-state", "idle");
                                            return;
                                        }
                                    };
                                    let config = state.config.lock().unwrap();
                                    (
                                        wav,
                                        config.server.url.clone(),
                                        config.server.asr_config_id.clone(),
                                        config.input.use_clipboard,
                                    )
                                };

                                let _ = app_handle.emit("hotkey-state", "recognizing");

                                match asr::recognize(&server_url, &asr_config_id, wav_bytes).await {
                                    Ok(text) if !text.trim().is_empty() => {
                                        let match_result = {
                                            let matcher = state.matcher.lock().unwrap();
                                            matcher.match_text(&text)
                                        };
                                        match match_result {
                                            voice_commands::MatchResult::Command(shortcut) => {
                                                log::info!("热键指令: {} → {}", text.trim(), shortcut);
                                                if let Err(e) = input_sim::send_shortcut(&shortcut) {
                                                    log::error!("执行快捷键失败: {e}");
                                                }
                                                let _ = app_handle.emit("hotkey-result",
                                                    format!("[指令] {} → {}", text.trim(), shortcut));
                                            }
                                            voice_commands::MatchResult::Text(t) => {
                                                log::info!("热键输入: {}", t);
                                                if let Err(e) = input_sim::type_text(&t, use_clipboard) {
                                                    log::error!("输入文本失败: {e}");
                                                }
                                                let _ = app_handle.emit("hotkey-result", t);
                                            }
                                        }
                                    }
                                    Ok(_) => {}
                                    Err(e) => {
                                        log::error!("热键 ASR 失败: {e}");
                                        let _ = app_handle.emit("hotkey-result", format!("错误: {e}"));
                                    }
                                }
                                let _ = app_handle.emit("hotkey-state", "idle");
                            });
                        }
                    }
                })
                .build(),
        )
        .manage(app_state)
        .invoke_handler(tauri::generate_handler![
            commands::start_recording,
            commands::stop_recording_and_recognize,
            commands::get_config,
            commands::get_vad_enabled,
            commands::toggle_vad,
        ])
        .setup(|app| {
            // 创建系统托盘
            if let Err(e) = tray::create_tray(app.handle()) {
                log::error!("创建托盘失败: {e}");
            }

            // 注册全局热键
            let config = app.state::<AppState>();
            let hotkey_str = config.config.lock().unwrap().hotkey.record.clone();
            match hotkey_str.parse::<tauri_plugin_global_shortcut::Shortcut>() {
                Ok(shortcut) => {
                    if let Err(e) = app.global_shortcut().register(shortcut) {
                        log::error!("注册热键 {hotkey_str} 失败: {e}");
                    } else {
                        log::info!("已注册热键: {hotkey_str}");
                    }
                }
                Err(e) => {
                    log::error!("解析热键 {hotkey_str} 失败: {e}");
                }
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("启动应用失败");
}
