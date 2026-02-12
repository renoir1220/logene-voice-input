use std::collections::HashMap;

/// 语音指令匹配器
pub struct VoiceCommandMatcher {
    /// 指令文本 → 快捷键
    commands: HashMap<String, String>,
}

/// 匹配结果
pub enum MatchResult {
    /// 匹配到语音指令，返回快捷键字符串
    Command(String),
    /// 未匹配，返回原始文本用于输入
    Text(String),
}

impl VoiceCommandMatcher {
    pub fn new(commands: HashMap<String, String>) -> Self {
        Self { commands }
    }

    /// 精确匹配（trim 后完全相等）
    pub fn match_text(&self, text: &str) -> MatchResult {
        let trimmed = text.trim();
        if let Some(shortcut) = self.commands.get(trimmed) {
            MatchResult::Command(shortcut.clone())
        } else {
            MatchResult::Text(trimmed.to_string())
        }
    }
}
