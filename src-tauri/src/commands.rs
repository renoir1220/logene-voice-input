use crate::audio::AudioState;
use crate::asr;
use crate::config::AppConfig;
use crate::input_sim;
use crate::vad::{VadController, VoiceActivityDetector};
use crate::voice_commands::{MatchResult, VoiceCommandMatcher};
use hound::WavSpec;
use std::io::Cursor;
use std::sync::{Arc, Mutex};
use tauri::State;

/// 应用共享状态
pub struct AppState {
    pub audio: Mutex<AudioState>,
    pub config: Mutex<AppConfig>,
    pub matcher: Mutex<VoiceCommandMatcher>,
    pub vad_controller: Mutex<VadController>,
}

/// 开始录音
#[tauri::command]
pub fn start_recording(state: State<'_, AppState>) -> Result<(), String> {
    state.audio.lock().unwrap().start_recording()
}

/// 停止录音并返回识别结果
#[tauri::command]
pub async fn stop_recording_and_recognize(state: State<'_, AppState>) -> Result<String, String> {
    let (wav_bytes, server_url, asr_config_id, use_clipboard) = {
        let audio = state.audio.lock().unwrap();
        audio.stop_recording()?;
        // 等待录音线程处理完停止指令
        std::thread::sleep(std::time::Duration::from_millis(100));
        let wav = audio.encode_wav()?;
        let config = state.config.lock().unwrap();
        (
            wav,
            config.server.url.clone(),
            config.server.asr_config_id.clone(),
            config.input.use_clipboard,
        )
    };

    // 调用 ASR
    let text = asr::recognize(&server_url, &asr_config_id, wav_bytes).await?;

    if text.trim().is_empty() {
        return Ok("".to_string());
    }

    // 匹配语音指令
    let match_result = {
        let matcher = state.matcher.lock().unwrap();
        matcher.match_text(&text)
    };

    match match_result {
        MatchResult::Command(shortcut) => {
            log::info!("语音指令匹配: {} → {}", text.trim(), shortcut);
            input_sim::send_shortcut(&shortcut)?;
            Ok(format!("[指令] {} → {}", text.trim(), shortcut))
        }
        MatchResult::Text(t) => {
            log::info!("输入文本: {}", t);
            input_sim::type_text(&t, use_clipboard)?;
            Ok(t)
        }
    }
}

/// 获取当前配置
#[tauri::command]
pub fn get_config(state: State<'_, AppState>) -> Result<AppConfig, String> {
    Ok(state.config.lock().unwrap().clone())
}

/// 获取 VAD 模式状态
#[tauri::command]
pub fn get_vad_enabled(state: State<'_, AppState>) -> bool {
    let controller = state.vad_controller.lock().unwrap();
    let enabled = *controller.enabled.lock().unwrap();
    enabled
}

/// 切换 VAD 模式
#[tauri::command]
pub fn toggle_vad(state: State<'_, AppState>) -> Result<bool, String> {
    let mut controller = state.vad_controller.lock().unwrap();
    let new_state = {
        let mut enabled = controller.enabled.lock().unwrap();
        let v = !*enabled;
        *enabled = v;
        v
    };

    if new_state {
        start_vad_loop(&state, &mut controller)?;
    } else {
        if let Some(tx) = controller.stop_tx.take() {
            let _ = tx.send(());
        }
    }

    Ok(new_state)
}

/// 启动 VAD 持续监听循环
fn start_vad_loop(
    state: &State<'_, AppState>,
    controller: &mut VadController,
) -> Result<(), String> {
    let (stop_tx, stop_rx) = std::sync::mpsc::channel::<()>();
    controller.stop_tx = Some(stop_tx);

    let config = state.config.lock().unwrap().clone();
    let enabled = controller.enabled.clone();

    // 获取音频设备信息
    let audio = state.audio.lock().unwrap();
    let _sample_rate = audio.sample_rate;
    drop(audio);

    let server_url = config.server.url.clone();
    let asr_config_id = config.server.asr_config_id.clone();
    let use_clipboard = config.input.use_clipboard;
    let voice_commands = config.voice_commands.clone();

    std::thread::spawn(move || {
        use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};

        let host = cpal::default_host();
        let device = match host.default_input_device() {
            Some(d) => d,
            None => {
                log::error!("VAD: 未找到麦克风");
                return;
            }
        };

        let supported = match device.default_input_config() {
            Ok(c) => c,
            Err(e) => {
                log::error!("VAD: 获取麦克风配置失败: {e}");
                return;
            }
        };

        let sr = supported.sample_rate().0;
        let channels = supported.channels();
        let stream_config = cpal::StreamConfig {
            channels,
            sample_rate: cpal::SampleRate(sr),
            buffer_size: cpal::BufferSize::Default,
        };

        let vad = Arc::new(Mutex::new(VoiceActivityDetector::new(
            config.vad.speech_threshold,
            config.vad.silence_timeout_ms,
            config.vad.min_speech_duration_ms,
        )));

        let vad_clone = vad.clone();
        let enabled_clone = enabled.clone();
        let matcher = VoiceCommandMatcher::new(voice_commands);
        let matcher = Arc::new(Mutex::new(matcher));
        let matcher_clone = matcher.clone();

        // 用于从音频回调传递待识别数据
        let (asr_tx, asr_rx) = std::sync::mpsc::channel::<Vec<f32>>();

        let stream = device
            .build_input_stream(
                &stream_config,
                move |data: &[f32], _: &cpal::InputCallbackInfo| {
                    if !*enabled_clone.lock().unwrap() {
                        return;
                    }
                    // 多声道转单声道
                    let mono: Vec<f32> = if channels > 1 {
                        data.chunks(channels as usize)
                            .map(|chunk| chunk.iter().sum::<f32>() / channels as f32)
                            .collect()
                    } else {
                        data.to_vec()
                    };

                    let mut vad = vad_clone.lock().unwrap();
                    if let Some(speech_data) = vad.process_frame(&mono) {
                        let _ = asr_tx.send(speech_data);
                    }
                },
                |err| log::error!("VAD 音频流错误: {err}"),
                None,
            )
            .expect("VAD: 创建音频流失败");

        stream.play().expect("VAD: 启动音频流失败");
        log::info!("VAD 模式已启动");

        // ASR 处理循环
        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        loop {
            // 检查停止信号
            if stop_rx.try_recv().is_ok() {
                log::info!("VAD 模式已停止");
                break;
            }

            // 检查是否有待识别的音频
            if let Ok(speech_data) = asr_rx.try_recv() {
                // 编码为 WAV
                let wav_bytes = encode_pcm_to_wav(&speech_data, sr);
                match wav_bytes {
                    Ok(wav) => {
                        let url = server_url.clone();
                        let config_id = asr_config_id.clone();
                        let uc = use_clipboard;
                        let m = matcher_clone.clone();
                        let vad_ref = vad.clone();

                        rt.block_on(async {
                            match asr::recognize(&url, &config_id, wav).await {
                                Ok(text) if !text.trim().is_empty() => {
                                    let result = {
                                        let matcher = m.lock().unwrap();
                                        matcher.match_text(&text)
                                    };
                                    match result {
                                        MatchResult::Command(shortcut) => {
                                            log::info!("VAD 指令: {} → {}", text.trim(), shortcut);
                                            if let Err(e) = input_sim::send_shortcut(&shortcut) {
                                                log::error!("执行快捷键失败: {e}");
                                            }
                                        }
                                        MatchResult::Text(t) => {
                                            log::info!("VAD 输入: {}", t);
                                            if let Err(e) = input_sim::type_text(&t, uc) {
                                                log::error!("输入文本失败: {e}");
                                            }
                                        }
                                    }
                                }
                                Ok(_) => {}
                                Err(e) => log::error!("VAD ASR 失败: {e}"),
                            }
                        });

                        // 重置 VAD 状态
                        vad_ref.lock().unwrap().reset();
                    }
                    Err(e) => {
                        log::error!("VAD WAV 编码失败: {e}");
                        vad.lock().unwrap().reset();
                    }
                }
            }

            std::thread::sleep(std::time::Duration::from_millis(50));
        }
    });

    Ok(())
}

/// 将 PCM f32 数据编码为 WAV bytes
fn encode_pcm_to_wav(samples: &[f32], sample_rate: u32) -> Result<Vec<u8>, String> {
    let spec = WavSpec {
        channels: 1,
        sample_rate,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };

    let mut cursor = Cursor::new(Vec::new());
    {
        let mut writer =
            hound::WavWriter::new(&mut cursor, spec).map_err(|e| format!("WAV 编码失败: {e}"))?;
        for &s in samples {
            let v = (s * 32767.0).clamp(-32768.0, 32767.0) as i16;
            writer.write_sample(v).map_err(|e| format!("WAV 写入失败: {e}"))?;
        }
        writer.finalize().map_err(|e| format!("WAV 完成失败: {e}"))?;
    }
    Ok(cursor.into_inner())
}
