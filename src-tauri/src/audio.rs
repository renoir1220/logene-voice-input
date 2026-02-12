use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use hound::{WavSpec, WavWriter};
use std::io::Cursor;
use std::sync::{Arc, Mutex};

/// 录音控制指令
pub enum AudioCommand {
    Start,
    Stop,
}

/// 录音状态
pub struct AudioState {
    /// 录音数据缓冲区（f32 PCM 样本）
    pub buffer: Arc<Mutex<Vec<f32>>>,
    /// 采样率
    pub sample_rate: u32,
    /// 声道数
    pub channels: u16,
    /// 控制指令发送端
    pub cmd_tx: Option<std::sync::mpsc::Sender<AudioCommand>>,
    /// 是否正在录音
    pub is_recording: Arc<Mutex<bool>>,
}

impl AudioState {
    pub fn new() -> Self {
        Self {
            buffer: Arc::new(Mutex::new(Vec::new())),
            sample_rate: 16000,
            channels: 1,
            cmd_tx: None,
            is_recording: Arc::new(Mutex::new(false)),
        }
    }

    /// 启动音频采集线程（cpal::Stream 不是 Send，需要专用线程）
    pub fn start_audio_thread(&mut self) -> Result<(), String> {
        let (cmd_tx, cmd_rx) = std::sync::mpsc::channel::<AudioCommand>();
        self.cmd_tx = Some(cmd_tx);

        let buffer = self.buffer.clone();
        let is_recording = self.is_recording.clone();

        // 先获取设备信息
        let host = cpal::default_host();
        let device = host
            .default_input_device()
            .ok_or("未找到麦克风设备")?;

        let supported_config = device
            .default_input_config()
            .map_err(|e| format!("获取麦克风配置失败: {e}"))?;

        let sample_rate = supported_config.sample_rate().0;
        let channels = supported_config.channels();
        self.sample_rate = sample_rate;
        self.channels = channels;

        let config = cpal::StreamConfig {
            channels,
            sample_rate: cpal::SampleRate(sample_rate),
            buffer_size: cpal::BufferSize::Default,
        };

        // 在专用线程中管理 cpal::Stream
        std::thread::spawn(move || {
            let stream = device
                .build_input_stream(
                    &config,
                    {
                        let buffer = buffer.clone();
                        let is_recording = is_recording.clone();
                        move |data: &[f32], _: &cpal::InputCallbackInfo| {
                            let recording = *is_recording.lock().unwrap();
                            if recording {
                                // 多声道转单声道
                                let mono: Vec<f32> = if channels > 1 {
                                    data.chunks(channels as usize)
                                        .map(|chunk| chunk.iter().sum::<f32>() / channels as f32)
                                        .collect()
                                } else {
                                    data.to_vec()
                                };
                                buffer.lock().unwrap().extend_from_slice(&mono);
                            }
                        }
                    },
                    |err| {
                        log::error!("音频流错误: {err}");
                    },
                    None,
                )
                .expect("创建音频流失败");

            stream.play().expect("启动音频流失败");

            // 等待控制指令
            loop {
                match cmd_rx.recv() {
                    Ok(AudioCommand::Start) => {
                        buffer.lock().unwrap().clear();
                        *is_recording.lock().unwrap() = true;
                        log::info!("开始录音");
                    }
                    Ok(AudioCommand::Stop) => {
                        *is_recording.lock().unwrap() = false;
                        log::info!("停止录音");
                    }
                    Err(_) => {
                        // 发送端已关闭，退出线程
                        log::info!("音频线程退出");
                        break;
                    }
                }
            }
        });

        Ok(())
    }

    /// 开始录音
    pub fn start_recording(&self) -> Result<(), String> {
        if let Some(tx) = &self.cmd_tx {
            tx.send(AudioCommand::Start)
                .map_err(|e| format!("发送录音指令失败: {e}"))?;
        }
        Ok(())
    }

    /// 停止录音
    pub fn stop_recording(&self) -> Result<(), String> {
        if let Some(tx) = &self.cmd_tx {
            tx.send(AudioCommand::Stop)
                .map_err(|e| format!("发送停止指令失败: {e}"))?;
        }
        Ok(())
    }

    /// 将缓冲区中的 PCM 数据编码为 WAV bytes
    pub fn encode_wav(&self) -> Result<Vec<u8>, String> {
        let samples = self.buffer.lock().unwrap().clone();
        if samples.is_empty() {
            return Err("录音数据为空".to_string());
        }

        let spec = WavSpec {
            channels: 1,
            sample_rate: self.sample_rate,
            bits_per_sample: 16,
            sample_format: hound::SampleFormat::Int,
        };

        let mut cursor = Cursor::new(Vec::new());
        {
            let mut writer =
                WavWriter::new(&mut cursor, spec).map_err(|e| format!("创建 WAV 写入器失败: {e}"))?;
            for &sample in &samples {
                // f32 [-1.0, 1.0] → i16
                let s = (sample * 32767.0).clamp(-32768.0, 32767.0) as i16;
                writer
                    .write_sample(s)
                    .map_err(|e| format!("写入 WAV 样本失败: {e}"))?;
            }
            writer
                .finalize()
                .map_err(|e| format!("完成 WAV 编码失败: {e}"))?;
        }

        Ok(cursor.into_inner())
    }
}
