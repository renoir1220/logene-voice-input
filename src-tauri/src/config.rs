use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

/// 应用配置
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AppConfig {
    pub server: ServerConfig,
    #[serde(default)]
    pub hotkey: HotkeyConfig,
    #[serde(default)]
    pub input: InputConfig,
    #[serde(default)]
    pub vad: VadConfig,
    /// 语音指令 → 快捷键映射，如 "肉眼所见" = "ALT+R"
    #[serde(default)]
    pub voice_commands: HashMap<String, String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ServerConfig {
    pub url: String,
    pub asr_config_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct HotkeyConfig {
    /// 录音热键，默认 "Ctrl+Space"
    #[serde(default = "default_record_hotkey")]
    pub record: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InputConfig {
    /// 是否使用剪贴板粘贴代替 SendInput
    #[serde(default)]
    pub use_clipboard: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VadConfig {
    /// 是否启用 VAD 智能模式
    #[serde(default)]
    pub enabled: bool,
    /// RMS 能量阈值
    #[serde(default = "default_speech_threshold")]
    pub speech_threshold: f32,
    /// 静音超时（毫秒）
    #[serde(default = "default_silence_timeout")]
    pub silence_timeout_ms: u64,
    /// 最短语音段（毫秒）
    #[serde(default = "default_min_speech_duration")]
    pub min_speech_duration_ms: u64,
}

fn default_record_hotkey() -> String {
    "Ctrl+Space".to_string()
}
fn default_speech_threshold() -> f32 {
    0.03
}
fn default_silence_timeout() -> u64 {
    800
}
fn default_min_speech_duration() -> u64 {
    300
}

impl Default for HotkeyConfig {
    fn default() -> Self {
        Self {
            record: default_record_hotkey(),
        }
    }
}

impl Default for InputConfig {
    fn default() -> Self {
        Self {
            use_clipboard: false,
        }
    }
}

impl Default for VadConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            speech_threshold: default_speech_threshold(),
            silence_timeout_ms: default_silence_timeout(),
            min_speech_duration_ms: default_min_speech_duration(),
        }
    }
}

/// 获取配置文件路径
pub fn config_path() -> PathBuf {
    let config_dir = dirs::config_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join("logene-voice-input");
    config_dir.join("config.toml")
}

/// 加载配置，文件不存在则创建默认配置
pub fn load_config() -> Result<AppConfig, String> {
    let path = config_path();
    if path.exists() {
        let content = fs::read_to_string(&path).map_err(|e| format!("读取配置失败: {e}"))?;
        toml::from_str(&content).map_err(|e| format!("解析配置失败: {e}"))
    } else {
        let config = default_config();
        save_config(&config)?;
        Ok(config)
    }
}

/// 保存配置到文件
pub fn save_config(config: &AppConfig) -> Result<(), String> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败: {e}"))?;
    }
    let content = toml::to_string_pretty(config).map_err(|e| format!("序列化配置失败: {e}"))?;
    fs::write(&path, content).map_err(|e| format!("写入配置失败: {e}"))?;
    Ok(())
}

/// 默认配置
fn default_config() -> AppConfig {
    let mut voice_commands = HashMap::new();
    voice_commands.insert("肉眼所见".to_string(), "ALT+R".to_string());
    voice_commands.insert("查询病人".to_string(), "ALT+Q".to_string());
    voice_commands.insert("材块数".to_string(), "ALT+C".to_string());
    voice_commands.insert("序列号".to_string(), "ALT+D".to_string());
    voice_commands.insert("取材医生".to_string(), "ALT+E".to_string());
    voice_commands.insert("上机状态".to_string(), "ALT+G".to_string());
    voice_commands.insert("上一个".to_string(), "ALT+A".to_string());
    voice_commands.insert("下一个".to_string(), "ALT+B".to_string());
    voice_commands.insert("附言".to_string(), "ALT+F".to_string());
    voice_commands.insert("保存报告".to_string(), "F2".to_string());
    voice_commands.insert("保存下例".to_string(), "F4".to_string());
    voice_commands.insert("病理号".to_string(), "F9".to_string());
    voice_commands.insert("组织名称".to_string(), "F7".to_string());
    voice_commands.insert("增加切片".to_string(), "F6".to_string());

    AppConfig {
        server: ServerConfig {
            url: "http://192.168.1.100:3000".to_string(),
            asr_config_id: "your-asr-config-id".to_string(),
        },
        hotkey: HotkeyConfig::default(),
        input: InputConfig::default(),
        vad: VadConfig::default(),
        voice_commands,
    }
}
