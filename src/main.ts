import './types'
import { installRendererErrorHooks } from './ui-state'
import { initFloatCapsuleUI } from './views/float'
import { initDashboardUI } from './views/dashboard'
import { initRewriteUI } from './views/rewrite'

installRendererErrorHooks()

// 设置平台标识，供 CSS 适配 Windows/macOS 差异
document.documentElement.setAttribute('data-platform', navigator.platform.startsWith('Win') ? 'win32' : 'darwin')

window.addEventListener('DOMContentLoaded', () => {
  if (window.location.hash.includes('rewrite')) {
    initRewriteUI()
    return
  }
  if (window.location.hash.includes('dashboard')) {
    initDashboardUI()
    return
  }
  initFloatCapsuleUI()
})
