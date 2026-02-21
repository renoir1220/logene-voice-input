import { BrowserWindow, screen, ipcMain, clipboard, IpcMainInvokeEvent } from 'electron'
import * as path from 'path'
import { copySelectedText, pasteClipboard } from './input-sim'
import { restoreFocus, getFrontmostApp } from './focus'
import { rewriteText } from './llm-service'
import { logger } from './logger'

let rewriteWindow: BrowserWindow | null = null
let lastActiveAppId: string | null = null

function stringifyErrorLike(value: unknown): string {
    if (value instanceof Error) return value.stack || `${value.name}: ${value.message}`
    if (typeof value === 'string') return value
    try {
        return JSON.stringify(value)
    } catch {
        return String(value)
    }
}

function attachRewriteWindowDiagnostics(win: BrowserWindow) {
    win.webContents.on('preload-error', (_event, preloadPath, error) => {
        logger.error(`[RewriteWindow] preload-error path=${preloadPath} err=${stringifyErrorLike(error)}`)
    })
    win.webContents.on('console-message', (_event, level, message, line, sourceId) => {
        if (level < 2) return
        const text = `[RewriteWindow] console level=${level} ${sourceId || 'unknown'}:${line} ${message}`
        if (level >= 3) logger.error(text)
        else logger.warn(text)
    })
    win.webContents.on('render-process-gone', (_event, details) => {
        logger.error(`[RewriteWindow] render-process-gone reason=${details.reason} exitCode=${details.exitCode}`)
    })
    win.webContents.on('did-fail-load', (_event, code, desc, url) => {
        logger.error(`[RewriteWindow] did-fail-load code=${code} desc=${desc} url=${url}`)
    })
}

export function initRewriteWindow() {
    const handle = (
        channel: string,
        fn: (event: IpcMainInvokeEvent, ...args: any[]) => unknown | Promise<unknown>,
    ) => {
        ipcMain.handle(channel, async (event, ...args) => {
            try {
                return await fn(event, ...args)
            } catch (e) {
                logger.error(`[IPC:${channel}] ${stringifyErrorLike(e)}`)
                throw e
            }
        })
    }

    handle('close-rewrite', () => {
        rewriteWindow?.hide()
    })

    handle('execute-rewrite', async (_event, text: string, instruction: string) => {
        try {
            const result = await rewriteText({
                text,
                instruction,
                onChunk: (chunk) => {
                    rewriteWindow?.webContents.send('rewrite-chunk', chunk)
                }
            })
            return result
        } catch (e: unknown) {
            if (e instanceof Error) throw new Error(e.message)
            throw new Error(String(e))
        }
    })

    handle('replace-text', async (_event, newText: string) => {
        rewriteWindow?.hide()
        await restoreFocus(lastActiveAppId)
        clipboard.writeText(newText)
        // 短暂延迟确保焦点切换与剪贴板完全就绪
        setTimeout(async () => {
            try {
                await pasteClipboard()
                logger.info(`[Rewrite] 文本覆盖替换成功。\n片段: [${newText.slice(0, 15)}...]`)
            } catch (e) {
                logger.error(`[Rewrite] 文本粘贴宏执行失败: ${e}`)
            }
        }, 50)
    })
}

export async function triggerRewrite() {
    lastActiveAppId = await getFrontmostApp() // 更新最新活跃窗体留底

    let text = ''
    try {
        text = await copySelectedText()
        logger.info(`[Rewrite] 从系统中捕获划取文本: ${text.slice(0, 20)}...`)
    } catch (e) {
        logger.error(`[Rewrite] 提取文本失败: ${e}`)
    }

    if (!text || !text.trim()) {
        logger.info('[Rewrite] 未获取到选区文本，将提供空白改写模板。')
        text = ''
    }

    if (!rewriteWindow) {
        createRewriteWindow()
        // 第一次创建时需要等待渲染进程加载完毕才能安全发送 IPC 数据
        rewriteWindow!.webContents.once('did-finish-load', () => {
            rewriteWindow!.show()
            rewriteWindow!.focus()
            rewriteWindow!.webContents.send('init-rewrite', text)
        })
    } else {
        rewriteWindow.show()
        rewriteWindow.focus()
        rewriteWindow.webContents.send('init-rewrite', text)
    }
}

function createRewriteWindow() {
    rewriteWindow = new BrowserWindow({
        width: 800,
        height: 600,
        frame: false,
        transparent: true,
        alwaysOnTop: true,
        skipTaskbar: true,
        show: false,
        hasShadow: false,
        backgroundColor: '#00000000',
        webPreferences: {
            preload: path.join(__dirname, '../preload/index.js'),
            contextIsolation: true,
        }
    })

    rewriteWindow.center()
    attachRewriteWindowDiagnostics(rewriteWindow)

    // 以 url hash 的形式定位路由
    if (process.env.ELECTRON_RENDERER_URL) {
        rewriteWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/rewrite`)
    } else {
        rewriteWindow.loadFile(path.join(__dirname, '../renderer/index.html'), { hash: 'rewrite' })
    }

    rewriteWindow.on('closed', () => { rewriteWindow = null })

    // 失去焦点时自动隐藏，回归沉浸
    rewriteWindow.on('blur', () => {
        rewriteWindow?.hide()
    })
}
