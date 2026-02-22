import { startCapture, stopCapture } from '../audio'
import {
  initFloatElements,
  uiTrace,
  captureFocusSnapshot,
  getFocusSnapshotAppId,
  getState,
  setState,
  showError,
  showResult,
  onRecordClick,
  setVadEnabled,
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

  const recordBtn = document.getElementById('record-btn') as HTMLButtonElement
  const vadToggleBtn = document.getElementById('vad-toggle-btn') as HTMLButtonElement | null

  // 悬浮球纯 JS 拖动兼顾单击双击兼容
  let isDragging = false
  let dragMoved = false
  let pointerId = -1
  let startX = 0, startY = 0
  let winStartX = 0, winStartY = 0

  recordBtn.addEventListener('pointerdown', async (e) => {
    if (e.button !== 0) return
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
      uiTrace('record-btn.pointerdown.ready', { focusSnapshotAppId: getFocusSnapshotAppId(), winStartX, winStartY })
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
    isDragging = false
    recordBtn.releasePointerCapture(pointerId)
    uiTrace('record-btn.pointerup', { pointerId: e.pointerId, dragMoved })
  })

  // 悬浮球事件（单击录音，双击/右键呼出面板）
  let clickTimer: ReturnType<typeof setTimeout> | null = null
  recordBtn.addEventListener('click', (e) => {
    if (dragMoved) {
      uiTrace('record-btn.click.ignored', { reason: 'drag-moved' })
      e.preventDefault()
      e.stopPropagation()
      return
    }
    if (clickTimer) return
    clickTimer = setTimeout(() => {
      clickTimer = null
      uiTrace('record-btn.click')
      onRecordClick()
    }, 250)
  })
  recordBtn.addEventListener('dblclick', (e) => {
    if (dragMoved) return
    if (clickTimer) { clearTimeout(clickTimer); clickTimer = null }
    window.electronAPI.openDashboard()
  })
  recordBtn.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    if (!dragMoved) window.electronAPI.showFloatContextMenu()
  })

  // VAD 按钮
  vadToggleBtn?.addEventListener('click', (e) => {
    e.preventDefault()
    e.stopPropagation()
    uiTrace('vad-btn.click', { targetEnabled: !vadState.enabled })
    setVadEnabled(!vadState.enabled)
  })

  // 监听热键状态
  window.electronAPI.onHotkeyState((s) => {
    if (s === 'recording') {
      if (getState() !== 'idle') return
      void (async () => {
        if (!await ensureAsrReadyBeforeCapture()) return
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
        await p.catch(() => { })
        setStartCapturePromise(null)
      }
      const wav = await stopCapture()
      console.log('[热键识别] 发送 WAV，大小:', wav.byteLength)
      const result = await window.electronAPI.recognizeWav(wav, prevAppId)
      console.log('[热键识别] 结果:', result)
      setState('idle')
      if (result) showResult(result)
    } catch (e) {
      console.error('[热键识别] 失败:', e)
      setState('idle')
      showError(String(e))
    }
  })

  // 托盘 VAD 切换
  window.electronAPI.onToggleVad((enabled) => {
    applyVadEnabled(Boolean(enabled), true).catch((e) => showError(String(e)))
  })
  window.electronAPI.onPermissionWarning((message) => {
    if (!message) return
    showError(message)
    console.warn('[权限提醒]', message)
  })
  window.electronAPI.onAsrRuntimeStatus((status) => {
    applyAsrRuntimeStatus(status)
  })
  void refreshAsrRuntimeStatus()

  initVad()
}
