import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

function shQuote(input: string): string {
  return `'${input.replace(/'/g, `'\\''`)}'`
}

async function run(cmd: string, timeout = 1200): Promise<string> {
  const { stdout } = await execAsync(cmd, { timeout })
  return stdout.trim()
}

async function getFrontmostAppDarwin(): Promise<string | null> {
  // 优先使用 lsappinfo：通常比 System Events 对权限要求更低，稳定性更好。
  try {
    const front = await run('lsappinfo front')
    const asnMatch = front.match(/ASN:[^\s]+/)
    if (asnMatch) {
      const info = await run(`lsappinfo info -only bundleid ${shQuote(asnMatch[0])}`)
      const bundleMatch = info.match(/"CFBundleIdentifier"="([^"]+)"/)
      if (bundleMatch?.[1]) return bundleMatch[1]
    }
  } catch {
    // fallback
  }

  // 次级回退：不依赖 System Events，直接读取 frontmost app 的 bundle id。
  try {
    const id = await run(`osascript -e 'id of app (path to frontmost application as text)'`)
    if (id) return id
  } catch {
    // fallback
  }

  // 最后回退：System Events（可能受 Automation/辅助功能权限影响）。
  try {
    const id = await run(
      `osascript -e 'tell application "System Events" to get bundle identifier of first application process whose frontmost is true'`,
    )
    if (id) return id
  } catch {
    // ignore
  }

  return null
}

// 获取当前前台应用标识（macOS: bundle id，Windows: hwnd，Linux: window id）
export async function getFrontmostApp(): Promise<string | null> {
  try {
    if (process.platform === 'darwin') {
      return await getFrontmostAppDarwin()
    } else if (process.platform === 'win32') {
      const { stdout } = await execAsync(
        `powershell -command "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class W { [DllImport(\\"user32.dll\\")] public static extern IntPtr GetForegroundWindow(); }'; [W]::GetForegroundWindow()"`,
        { timeout: 1200 },
      )
      return stdout.trim() || null
    } else {
      const { stdout } = await execAsync('xdotool getactivewindow', { timeout: 1200 })
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
      const safeAppId = appId.replace(/"/g, '\\"')
      await execAsync(
        `osascript -e 'tell application id "${safeAppId}" to activate'`,
        { timeout: 1500 },
      )
    } else if (process.platform === 'win32') {
      // Windows：通过 hwnd 还原焦点
      await execAsync(
        `powershell -command "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public class W { [DllImport(\\"user32.dll\\")] public static extern bool SetForegroundWindow(IntPtr hWnd); }'; [W]::SetForegroundWindow(${appId})"`,
        { timeout: 1500 },
      )
    } else {
      await execAsync(`xdotool windowfocus ${appId}`, { timeout: 1500 })
    }
    // 等待焦点切换完成
    await new Promise(r => setTimeout(r, 100))
  } catch {
    // 焦点还原失败不影响主流程
  }
}
