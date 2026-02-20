// 语音指令匹配：精确匹配（trim + 去除尾部标点后完全相等）
export function matchVoiceCommand(
  text: string,
  commands: Record<string, string>,
): { type: 'command'; shortcut: string } | { type: 'text'; text: string } {
  const trimmed = text.trim()
  const stripped = stripPunctuation(trimmed)
  if (commands[stripped]) {
    return { type: 'command', shortcut: commands[stripped] }
  }
  return { type: 'text', text: trimmed }
}

// 去除首尾中英文标点
function stripPunctuation(s: string): string {
  return s.replace(/^[\s。，！？、；：.,!?;:"'「」""'']+|[\s。，！？、；：.,!?;:"'「」""'']+$/gu, '')
}
