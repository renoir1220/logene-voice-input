use std::sync::{Arc, Mutex};
use std::time::Instant;

/// VAD 状态机状态
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum VadState {
    /// 空闲，等待语音
    Idle,
    /// 检测到语音，正在录音
    Speaking,
    /// 语音结束，等待处理
    Processing,
}

/// 语音活动检测器
pub struct VoiceActivityDetector {
    /// 当前状态
    pub state: VadState,
    /// RMS 能量阈值
    speech_threshold: f32,
    /// 静音超时（毫秒）
    silence_timeout_ms: u64,
    /// 最短语音段（毫秒）
    min_speech_duration_ms: u64,
    /// 语音开始时间
    speech_start: Option<Instant>,
    /// 最后检测到语音的时间
    last_speech_time: Option<Instant>,
    /// 音频缓冲区
    pub buffer: Vec<f32>,
}

impl VoiceActivityDetector {
    pub fn new(speech_threshold: f32, silence_timeout_ms: u64, min_speech_duration_ms: u64) -> Self {
        Self {
            state: VadState::Idle,
            speech_threshold,
            silence_timeout_ms,
            min_speech_duration_ms,
            speech_start: None,
            last_speech_time: None,
            buffer: Vec::new(),
        }
    }

    /// 计算音频帧的 RMS 能量
    fn rms(samples: &[f32]) -> f32 {
        if samples.is_empty() {
            return 0.0;
        }
        let sum: f32 = samples.iter().map(|s| s * s).sum();
        (sum / samples.len() as f32).sqrt()
    }

    /// 处理一帧音频数据，返回是否应该触发识别
    /// 如果返回 Some(data)，表示应该将 data 发送给 ASR
    pub fn process_frame(&mut self, samples: &[f32]) -> Option<Vec<f32>> {
        let energy = Self::rms(samples);
        let is_speech = energy > self.speech_threshold;
        let now = Instant::now();

        match self.state {
            VadState::Idle => {
                if is_speech {
                    // 检测到语音开始
                    self.state = VadState::Speaking;
                    self.speech_start = Some(now);
                    self.last_speech_time = Some(now);
                    self.buffer.clear();
                    self.buffer.extend_from_slice(samples);
                    log::info!("VAD: 检测到语音开始");
                }
                None
            }
            VadState::Speaking => {
                // 持续缓存音频
                self.buffer.extend_from_slice(samples);

                if is_speech {
                    self.last_speech_time = Some(now);
                } else if let Some(last) = self.last_speech_time {
                    // 检查静音是否超过阈值
                    let silence_duration = now.duration_since(last).as_millis() as u64;
                    if silence_duration >= self.silence_timeout_ms {
                        // 检查语音段是否足够长
                        if let Some(start) = self.speech_start {
                            let speech_duration = now.duration_since(start).as_millis() as u64;
                            if speech_duration >= self.min_speech_duration_ms {
                                // 语音段有效，触发识别
                                self.state = VadState::Processing;
                                log::info!("VAD: 语音段结束，时长 {speech_duration}ms，触发识别");
                                let data = std::mem::take(&mut self.buffer);
                                return Some(data);
                            }
                        }
                        // 语音段太短，丢弃
                        log::info!("VAD: 语音段过短，丢弃");
                        self.reset();
                    }
                }
                None
            }
            VadState::Processing => {
                // 正在处理中，忽略新数据（等待 ASR 返回后重置为 Idle）
                None
            }
        }
    }

    /// 重置为空闲状态
    pub fn reset(&mut self) {
        self.state = VadState::Idle;
        self.speech_start = None;
        self.last_speech_time = None;
        self.buffer.clear();
    }
}

/// VAD 模式控制
pub struct VadController {
    /// 是否启用
    pub enabled: Arc<Mutex<bool>>,
    /// 停止信号
    pub stop_tx: Option<std::sync::mpsc::Sender<()>>,
}

impl VadController {
    pub fn new() -> Self {
        Self {
            enabled: Arc::new(Mutex::new(false)),
            stop_tx: None,
        }
    }
}
