import { showError } from '../ui-state'

export function initRewriteUI() {
  document.getElementById('float-capsule-view')!.style.display = 'none'
  document.getElementById('main-dashboard-view')!.style.display = 'none'
  document.getElementById('rewrite-view')!.classList.add('active')

  const originalEl = document.getElementById('rw-original-text') as HTMLTextAreaElement
  const instructEl = document.getElementById('rw-instruction') as HTMLInputElement
  const resultEl = document.getElementById('rw-result-text') as HTMLTextAreaElement
  const statusEl = document.getElementById('rw-status-indicator') as HTMLSpanElement
  const copyBtn = document.getElementById('rw-copy-btn') as HTMLButtonElement
  const replaceBtn = document.getElementById('rw-replace-btn') as HTMLButtonElement
  const cancelBtn = document.getElementById('rw-cancel-btn') as HTMLButtonElement
  const closeBtn = document.getElementById('rw-close-btn') as HTMLButtonElement
  const submitBtn = document.getElementById('rw-submit-btn') as HTMLButtonElement

  window.electronAPI.onInitRewrite((text: string) => {
    originalEl.value = text
    instructEl.value = ''
    resultEl.value = ''
    statusEl.textContent = '等待指令'
    replaceBtn.disabled = true
    instructEl.focus()
  })

  window.electronAPI.onRewriteChunk((chunk: string) => {
    resultEl.value += chunk
    resultEl.scrollTop = resultEl.scrollHeight
  })

  async function doRewrite() {
    const text = originalEl.value
    const instruction = instructEl.value.trim()
    if (!instruction) return

    statusEl.textContent = '生成中...'
    resultEl.value = ''
    submitBtn.disabled = true

    try {
      await window.electronAPI.executeRewrite(text, instruction)
      statusEl.textContent = '生成完成'
      replaceBtn.disabled = false
      replaceBtn.focus()
    } catch (e: unknown) {
      statusEl.textContent = '出错'
      resultEl.value = '调用错误: ' + String(e)
    } finally {
      submitBtn.disabled = false
    }
  }

  submitBtn.addEventListener('click', doRewrite)
  instructEl.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') doRewrite()
  })

  replaceBtn.addEventListener('click', () => {
    window.electronAPI.replaceText(resultEl.value)
  })

  copyBtn.addEventListener('click', () => {
    if (!resultEl.value) return
    window.electronAPI.copyToClipboard(resultEl.value).then(() => {
      const oldText = copyBtn.textContent
      copyBtn.textContent = '已复制!'
      setTimeout(() => { copyBtn.textContent = oldText }, 2000)
    }).catch((e) => {
      showError(`复制失败: ${String(e)}`)
    })
  })

  cancelBtn.addEventListener('click', () => window.electronAPI.closeRewrite())
  closeBtn.addEventListener('click', () => window.electronAPI.closeRewrite())

  // 全局热键
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      window.electronAPI.closeRewrite()
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      if (!replaceBtn.disabled) {
        window.electronAPI.replaceText(resultEl.value)
      }
    }
  })
}
