use enigo::{Direction, Enigo, Key, Keyboard, Settings};

/// 模拟键盘输入文本
pub fn type_text(text: &str, use_clipboard: bool) -> Result<(), String> {
    if use_clipboard {
        type_via_clipboard(text)
    } else {
        type_via_keyboard(text)
    }
}

/// 通过键盘直接输入（enigo SendInput）
fn type_via_keyboard(text: &str) -> Result<(), String> {
    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| format!("初始化 enigo 失败: {e}"))?;
    enigo
        .text(text)
        .map_err(|e| format!("输入文本失败: {e}"))?;
    Ok(())
}

/// 通过剪贴板 + Ctrl+V 输入
fn type_via_clipboard(text: &str) -> Result<(), String> {
    let mut clipboard = arboard::Clipboard::new()
        .map_err(|e| format!("打开剪贴板失败: {e}"))?;
    clipboard
        .set_text(text)
        .map_err(|e| format!("写入剪贴板失败: {e}"))?;

    // 短暂延迟确保剪贴板就绪
    std::thread::sleep(std::time::Duration::from_millis(50));

    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| format!("初始化 enigo 失败: {e}"))?;

    // Ctrl+V 粘贴
    enigo.key(Key::Control, Direction::Press)
        .map_err(|e| format!("按键失败: {e}"))?;
    enigo.key(Key::Unicode('v'), Direction::Click)
        .map_err(|e| format!("按键失败: {e}"))?;
    enigo.key(Key::Control, Direction::Release)
        .map_err(|e| format!("按键失败: {e}"))?;

    Ok(())
}

/// 模拟组合键，如 "ALT+R"、"CTRL+SHIFT+S"、"F2"
pub fn send_shortcut(shortcut: &str) -> Result<(), String> {
    let mut enigo = Enigo::new(&Settings::default())
        .map_err(|e| format!("初始化 enigo 失败: {e}"))?;

    let keys = parse_shortcut(shortcut)?;

    // 按序按下所有键
    for key in &keys {
        enigo.key(*key, Direction::Press)
            .map_err(|e| format!("按下 {shortcut} 失败: {e}"))?;
    }

    // 逆序释放所有键
    for key in keys.iter().rev() {
        enigo.key(*key, Direction::Release)
            .map_err(|e| format!("释放 {shortcut} 失败: {e}"))?;
    }

    Ok(())
}

/// 解析快捷键字符串为 enigo Key 列表
fn parse_shortcut(shortcut: &str) -> Result<Vec<Key>, String> {
    shortcut
        .split('+')
        .map(|part| parse_key(part.trim()))
        .collect()
}

/// 解析单个按键名称
fn parse_key(name: &str) -> Result<Key, String> {
    match name.to_uppercase().as_str() {
        "CTRL" | "CONTROL" => Ok(Key::Control),
        "ALT" => Ok(Key::Alt),
        "SHIFT" => Ok(Key::Shift),
        "META" | "WIN" | "SUPER" => Ok(Key::Meta),
        "TAB" => Ok(Key::Tab),
        "ENTER" | "RETURN" => Ok(Key::Return),
        "ESCAPE" | "ESC" => Ok(Key::Escape),
        "SPACE" => Ok(Key::Space),
        "BACKSPACE" => Ok(Key::Backspace),
        "DELETE" | "DEL" => Ok(Key::Delete),
        "UP" => Ok(Key::UpArrow),
        "DOWN" => Ok(Key::DownArrow),
        "LEFT" => Ok(Key::LeftArrow),
        "RIGHT" => Ok(Key::RightArrow),
        "HOME" => Ok(Key::Home),
        "END" => Ok(Key::End),
        "PAGEUP" => Ok(Key::PageUp),
        "PAGEDOWN" => Ok(Key::PageDown),
        "F1" => Ok(Key::F1),
        "F2" => Ok(Key::F2),
        "F3" => Ok(Key::F3),
        "F4" => Ok(Key::F4),
        "F5" => Ok(Key::F5),
        "F6" => Ok(Key::F6),
        "F7" => Ok(Key::F7),
        "F8" => Ok(Key::F8),
        "F9" => Ok(Key::F9),
        "F10" => Ok(Key::F10),
        "F11" => Ok(Key::F11),
        "F12" => Ok(Key::F12),
        s if s.len() == 1 => {
            let c = s.chars().next().unwrap().to_ascii_lowercase();
            Ok(Key::Unicode(c))
        }
        _ => Err(format!("未知按键: {name}")),
    }
}
