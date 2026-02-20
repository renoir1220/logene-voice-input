import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

// 获取当前前台应用标识（macOS: bundle id，Windows: hwnd，Linux: window id）
export async function getFrontmostApp(): Promise<string | null> {
  try {
    if (process.platform === 'darwin') {
      const { stdout } = await execAsync(
        `osascript -e 'tell application "System Events" to get bundle identifier of first application process whose frontmost is true'`,
      )
      return stdout.trim() || null
    } else if (process.platform === 'win32') {
      const { stdout } = await execAsync(
        `powershell -command "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class W { [DllImport(\\"user32.dll\\")] public static extern IntPtr GetForegroundWindow(); }'; [W]::GetForegroundWindow()"`,
      )
      return stdout.trim() || null
    } else {
      const { stdout } = await execAsync('xdotool getactivewindow')
      return stdout.trim() || null
    }
  } catch {
    return null
  }
}

// 还原焦点到指定应用
export async function restoreFocus(appId: string | null): Promise<void> {
  if (!appId) return
  try {
    if (process.platform === 'darwin') {
      await execAsync(
        `osascript -e 'tell application id "${appId}" to activate'`,
      )
    } else if (process.platform === 'win32') {
      // Windows：通过 hwnd 还原焦点
      await execAsync(
        `powershell -command "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class W { [DllImport(\\"user32.dll\\")] public static extern bool SetForegroundWindow(IntPtr hWnd); }'; [W]::SetForegroundWindow(${appId})"`,
      )
    } else {
      await execAsync(`xdotool windowfocus ${appId}`)
    }
    // 等待焦点切换完成
    await new Promise(r => setTimeout(r, 100))
  } catch {
    // 焦点还原失败不影响主流程
  }
}
