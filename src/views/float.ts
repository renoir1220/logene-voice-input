import { startCapture, stopCapture } from '../audio'
import type { FloatLayoutMetrics } from '../types'
import {
  initFloatElements,
  uiTrace,
  captureFocusSnapshot,
  getState,
  setState,
  showError,
  showResult,
  onRecordClick,
  setVadEnabled,
  applyVadThreshold,
  applyVadEnabled,
  initVad,
  ensureAsrReadyBeforeCapture,
  applyAsrRuntimeStatus,
  refreshAsrRuntimeStatus,
  getStartCapturePromise,
  setStartCapturePromise,
  vadState,
} from '../ui-state'

export function initFloatCapsuleUI() {
  document.getElementById('float-capsule-view')!.classList.add('active')
  document.getElementById('main-dashboard-view')!.classList.remove('active')

  initFloatElements()
  const fallbackPanel = document.getElementById('float-fallback-panel') as HTMLDivElement | null
  const fallbackHint = document.getElementById('float-fallback-hint') as HTMLDivElement | null
  const fallbackText = document.getElementById('float-fallback-text') as HTMLDivElement | null
  const fallbackCopyBtn = document.getElementById('float-fallback-copy-btn') as HTMLButtonElement | null
  const fallbackCloseBtn = document.getElementById('float-fallback-close-btn') as HTMLButtonElement | null
  const floatView = document.getElementById('float-capsule-view') as HTMLDivElement | null
  const floatLayoutRoot = document.getElementById('float-layout-root') as HTMLDivElement | null
  const capsuleContainer = floatLayoutRoot?.querySelector('.capsule-container') as HTMLDivElement | null

  const recordBtn = document.getElementById('record-btn') as HTMLButtonElement
  const vadToggleBtn = document.getElementById('vad-toggle-btn') as HTMLButtonElement | null
  let ignoreMouseEvents = false
  let layoutSyncQueued = false
  let lastLayoutKey = ''
  let fallbackPayload: {
    requestId: number
    text: string
    targetAppId: string | null
    reason: 'no-foreground-window' | 'no-focused-control' | 'focused-control-without-caret' | 'type-failed' | 'restore-failed'
    precheckReason: 'ok' | 'unknown' | 'no-foreground-window' | 'no-focused-control' | 'focused-control-without-caret'
  } | null = null

  const setFloatBoundsDebug = (enabled: boolean) => {
    document.body.classList.toggle('float-bounds-debug', enabled)
    scheduleLayoutSync()
  }

  const setMousePassthrough = (ignore: boolean) => {
    if (ignoreMouseEvents === ignore) return
    ignoreMouseEvents = ignore
    void window.electronAPI.setIgnoreMouseEvents(ignore, ignore ? { forward: true } : undefined).catch(() => { })
  }

  const isPassThroughTarget = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return true
    if (target.closest('#record-btn, #vad-toggle-btn, .capsule-container, .float-fallback-panel')) return false
    return true
  }

  const updateMousePassthrough = (target: EventTarget | null) => {
    if (!floatView || !floatView.classList.contains('active') || isDragging) {
      setMousePassthrough(false)
      return
    }
    setMousePassthrough(isPassThroughTarget(target))
  }

  const collectLayoutMetrics = (): FloatLayoutMetrics | null => {
    if (!floatLayoutRoot || !capsuleContainer) return null
    const layoutRect = floatLayoutRoot.getBoundingClientRect()
    const capsuleRect = capsuleContainer.getBoundingClientRect()
    const width = Math.ceil(layoutRect.width)
    const height = Math.ceil(layoutRect.height)
    if (width <= 0 || height <= 0) return null
    return {
      width,
      height,
      anchorX: Math.max(0, Math.round(capsuleRect.left - layoutRect.left)),
      anchorY: Math.max(0, Math.round(capsuleRect.top - layoutRect.top)),
    }
  }

  const flushLayoutSync = () => {
    layoutSyncQueued = false
    const metrics = collectLayoutMetrics()
    if (!metrics) return
    const layoutKey = `${metrics.width}:${metrics.height}:${metrics.anchorX}:${metrics.anchorY}`
    if (layoutKey === lastLayoutKey) return
    lastLayoutKey = layoutKey
    void window.electronAPI.syncFloatLayout(metrics).catch(() => { })
  }

  const scheduleLayoutSync = () => {
    if (layoutSyncQueued) return
    layoutSyncQueued = true
    window.requestAnimationFrame(flushLayoutSync)
  }

  const hideFallbackPanel = (syncOnly = false) => {
    fallbackPayload = null
    if (fallbackPanel) fallbackPanel.hidden = true
    scheduleLayoutSync()
    if (syncOnly) return
    void window.electronAPI.setFloatExpanded(false).catch(() => { })
  }

  const showFallbackPanel = (payload: {
    requestId: number
    text: string
    targetAppId: string | null
    reason: 'no-foreground-window' | 'no-focused-control' | 'focused-control-without-caret' | 'type-failed' | 'restore-failed'
    precheckReason: 'ok' | 'unknown' | 'no-foreground-window' | 'no-focused-control' | 'focused-control-without-caret'
  }) => {
    fallbackPayload = payload
    if (fallbackText) {
      fallbackText.textContent = payload.text
      fallbackText.title = payload.text
    }
    if (fallbackHint) {
      fallbackHint.textContent = payload.reason === 'type-failed'
        ? '自动粘贴失败，结果已暂存'
        : '未检测到可写焦点，结果已暂存'
    }
    if (fallbackPanel) fallbackPanel.hidden = false
    scheduleLayoutSync()
    void window.electronAPI.setFloatExpanded(true).catch(() => { })
  }

  // 悬浮球纯 JS 拖动兼顾单击双击兼容
  let isDragging = false
  let dragMoved = false
  let suppressClickUntil = 0
  let pointerId = -1
  let startX = 0, startY = 0
  let winStartX = 0, winStartY = 0

  recordBtn.addEventListener('pointerdown', async (e) => {
    if (e.button !== 0) return
    setMousePassthrough(false)
    uiTrace('record-btn.pointerdown', { button: e.button, pointerId: e.pointerId })
    isDragging = true
    dragMoved = false
    pointerId = e.pointerId
    recordBtn.setPointerCapture(pointerId)

    try {
      startX = e.screenX
      startY = e.screenY
      const snapshotPromise = captureFocusSnapshot('record-pointerdown')
      const pos = await window.electronAPI.getWindowPosition()
      winStartX = pos[0]
      winStartY = pos[1]
      await snapshotPromise
      uiTrace('record-btn.pointerdown.ready', { winStartX, winStartY })
    } catch (err) {
      uiTrace('record-btn.pointerdown.error', { error: String(err) })
    }
  })

  recordBtn.addEventListener('pointermove', (e) => {
    if (!isDragging) return
    const dx = e.screenX - startX
    const dy = e.screenY - startY
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragMoved = true
    if (dragMoved) {
      window.electronAPI.setWindowPosition(winStartX + dx, winStartY + dy)
    }
  })

  recordBtn.addEventListener('pointerup', (e) => {
    if (!isDragging) return
    const moved = dragMoved
    isDragging = false
    recordBtn.releasePointerCapture(pointerId)
    if (moved) {
      // 仅抑制拖动后紧随的 click，避免误触发录音；不影响右键菜单。
      suppressClickUntil = Date.now() + 250
    }
    dragMoved = false
    uiTrace('record-btn.pointerup', { pointerId: e.pointerId, dragMoved: moved })
    updateMousePassthrough(document.elementFromPoint(e.clientX, e.clientY))
  })

  // 悬浮球事件（单击录音，双击/右键呼出面板）
  // TODO: Windows 透明窗口下单击可能不生效，待去掉透明后统一修复
  let clickTimer: ReturnType<typeof setTimeout> | null = null
  recordBtn.addEventListener('click', (e) => {
    if (Date.now() < suppressClickUntil) { e.preventDefault(); e.stopPropagation(); return }
    if (clickTimer) return
    clickTimer = setTimeout(() => {
      clickTimer = null
      hideFallbackPanel()
      onRecordClick()
    }, 250)
  })
  recordBtn.addEventListener('dblclick', (e) => {
    if (Date.now() < suppressClickUntil) return
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null }
    window.electronAPI.openDashboard()
  })
  // 统一在捕获阶段拦截右键，确保点到任意子元素（含 SVG/path）都能触发菜单。
  document.addEventListener('contextmenu', (event) => {
    const target = event.target
    if (!floatView || !floatView.classList.contains('active')) return
    if (!(target instanceof Node) || !floatView.contains(target)) return
    event.preventDefault()
    event.stopPropagation()
    void window.electronAPI.showFloatContextMenu()
  }, true)
  window.addEventListener('mousemove', (event) => {
    updateMousePassthrough(event.target)
  })
  window.addEventListener('blur', () => {
    setMousePassthrough(false)
  })
  document.addEventListener('mouseleave', () => {
    setMousePassthrough(false)
  })

  // VAD 按钮
  vadToggleBtn?.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    setVadEnabled(!vadState.enabled)
  })

  // 监听热键状态
  window.electronAPI.onHotkeyState((s) => {
    if (s === 'recording') {
      if (getState() !== 'idle') return
      void (async () => {
        if (!await ensureAsrReadyBeforeCapture()) return
        hideFallbackPanel()
        setState('recording')
        const p = startCapture()
        setStartCapturePromise(p)
        p.catch(e => showError(String(e)))
      })()
    } else if (s === 'recognizing') {
      setState('recognizing')
    } else {
      setState('idle')
    }
  })

  // 热键停止录音
  window.electronAPI.onHotkeyStopRecording(async (prevAppId) => {
    if (getState() !== 'recording') return
    setState('recognizing')
    try {
      const p = getStartCapturePromise()
      if (p) {
        await p // 如果 startCapture 失败，直接抛出进入 catch
        setStartCapturePromise(null)
      }
      const wav = await stopCapture()
      const result = await window.electronAPI.recognizeWav(wav, prevAppId)
      setState('idle')
      if (result) showResult(result)
    } catch (e) {
      setState('idle')
      showError(String(e))
    }
  })

  // 托盘 VAD 切换
  window.electronAPI.onToggleVad((enabled) => {
    applyVadEnabled(Boolean(enabled), true).catch((e) => showError(String(e)))
  })
  window.electronAPI.onVadThresholdUpdated((threshold) => {
    applyVadThreshold(threshold)
  })
  window.electronAPI.onPermissionWarning((message) => {
    if (!message) return
    showError(message)
  })
  window.electronAPI.onAsrRuntimeStatus((status) => {
    applyAsrRuntimeStatus(status)
  })
  window.electronAPI.onFloatPasteFallback((payload) => {
    showFallbackPanel(payload)
  })
  window.electronAPI.onFloatDebugBoundsUpdated((enabled) => {
    setFloatBoundsDebug(enabled)
  })
  void refreshAsrRuntimeStatus()
  void window.electronAPI.getConfig()
    .then((cfg) => setFloatBoundsDebug(Boolean(cfg.logging?.showFloatBounds)))
    .catch(() => { })

  fallbackCopyBtn?.addEventListener('click', async (e) => {
    e.preventDefault()
    e.stopPropagation()
    if (!fallbackPayload) return
    try {
      await window.electronAPI.copyToClipboard(fallbackPayload.text)
      showResult('已复制到剪贴板')
      hideFallbackPanel()
    } catch (err) {
      showError(String(err))
    }
  })

  fallbackCloseBtn?.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    hideFallbackPanel()
  })

  if (floatLayoutRoot) {
    const resizeObserver = new ResizeObserver(() => {
      scheduleLayoutSync()
    })
    resizeObserver.observe(floatLayoutRoot)
  }
  scheduleLayoutSync()
  initVad()
}
