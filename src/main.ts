import './types'
import { installRendererErrorHooks } from './ui-state'
import { initFloatCapsuleUI } from './views/float'
import { initDashboardUI } from './views/dashboard'
import { initRewriteUI } from './views/rewrite'

installRendererErrorHooks()

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
