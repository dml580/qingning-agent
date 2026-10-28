import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import App from './App'
import { AgentProvider } from './context/AgentContext'
import { applyTheme, readTheme } from './theme'
import './index.css'

applyTheme(readTheme())

if ('serviceWorker' in navigator && import.meta.env.DEV) {
  // 开发环境清理 Service Worker，避免缓存 Vite 源码或旧登录页。
  void (async () => {
    const legacyWorkerPath = ['', 'sw.js'].join('/')
    const registrations = await navigator.serviceWorker.getRegistrations()
    const owned = registrations.filter((registration) =>
      [registration.active, registration.waiting, registration.installing].some(
        (worker) => worker && new URL(worker.scriptURL).pathname === legacyWorkerPath,
      ),
    )
    const controlledByLegacyWorker =
      navigator.serviceWorker.controller &&
      new URL(navigator.serviceWorker.controller.scriptURL).pathname === legacyWorkerPath
    await Promise.all(owned.map((registration) => registration.unregister()))
    const keys = await caches.keys()
    await Promise.all(
      keys
        .filter((key) => key.startsWith('qingning-shell-'))
        .map((key) => caches.delete(key)),
    )
    if (owned.length && controlledByLegacyWorker) window.location.reload()
  })().catch((error) => console.warn('清理旧版离线缓存失败', error))
}

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').then((registration) => {
      // 每次打开生产版都检查新外壳；新 worker 会 skipWaiting + claim。
      void registration.update()
    }).catch((error) => console.warn('PWA 启用失败', error))
  })
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AgentProvider>
      <App />
    </AgentProvider>
  </StrictMode>,
)
