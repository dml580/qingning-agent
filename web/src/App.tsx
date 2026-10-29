import { useEffect, useState } from 'react'
import { api, setUnauthorizedHandler, type ReminderItem } from './api/client'
import { AboutDrawer } from './components/AboutDrawer'
import { ActionBanner } from './components/ActionBanner'
import { CompatBanner } from './components/CompatBanner'
import { InputArea } from './components/InputArea'
import { LoginPage } from './components/LoginPage'
import { MessageArea } from './components/MessageArea'
import { ModelSettingsDrawer } from './components/ModelSettingsDrawer'
import { ModuleRail } from './components/ModuleRail'
import { PetChatDrawer } from './components/PetChatDrawer'
import { QingningPet } from './components/QingningPet'
import { ReminderBoard } from './components/ReminderBoard'
import { ScenarioBar } from './components/ScenarioBar'
import { SessionList } from './components/SessionList'
import { SkillCenter } from './components/SkillCenter'
import { DiagnosticsDrawer } from './components/DiagnosticsDrawer'
import { ThemeSwitcher } from './components/ThemeSwitcher'
import { useAgent } from './context/AgentContext'
import './App.css'

const REMINDER_NOTIFY_KEY = 'qingning_reminder_notified_v2'

interface DeferredInstallPromptEvent extends Event {
  readonly platforms: string[]
  prompt: () => Promise<void>
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed'; platform: string }>
}

function todayLocal(now: Date = new Date()): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function loadNotified(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(REMINDER_NOTIFY_KEY) || '{}') as Record<
      string,
      string
    >
  } catch {
    return {}
  }
}

function markNotified(id: string, stamp: string) {
  const next = loadNotified()
  next[id] = stamp
  localStorage.setItem(REMINDER_NOTIFY_KEY, JSON.stringify(next))
}

function dueStamp(item: ReminderItem): string {
  return `${item.due_date} ${item.due_time || 'date'}`
}

function reminderDueMs(item: ReminderItem): number | null {
  if (!item.due_time) return null
  const ms = new Date(`${item.due_date}T${item.due_time}:00`).getTime()
  return Number.isFinite(ms) ? ms : null
}

function isReminderDue(item: ReminderItem, now: Date): boolean {
  if (!item.notify_browser || item.done) return false
  const dueMs = reminderDueMs(item)
  if (dueMs != null) return now.getTime() >= dueMs
  return item.due_date <= todayLocal(now)
}

async function maybeNotifyDue(items: ReminderItem[], now = new Date()) {
  if (typeof Notification === 'undefined') return
  if (Notification.permission !== 'granted') return
  const notified = loadNotified()
  const today = todayLocal(now)
  for (const item of items) {
    if (!isReminderDue(item, now)) continue
    const stamp = dueStamp(item)
    if (notified[item.id] === stamp) continue
    const tag = item.due_time
      ? `到点提醒 ${item.due_time}`
      : item.due_date < today
        ? '已过期'
        : '今天到期'
    try {
      new Notification(`青柠提醒 · ${tag}`, {
        body: `${item.title}${item.note ? ` — ${item.note}` : ''}`,
        tag: `qingning-rem-${item.id}-${stamp}`,
      })
      markNotified(item.id, stamp)
    } catch {
      /* ignore */
    }
  }
}

export default function App() {
  const wb = useAgent()
  const [showAbout, setShowAbout] = useState(false)
  const [showModelSettings, setShowModelSettings] = useState(false)
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [sessionListCollapsed, setSessionListCollapsed] = useState(false)
  const [mobileMore, setMobileMore] = useState(false)
  const [petChatOpen, setPetChatOpen] = useState(false)
  const [composerHint, setComposerHint] = useState('')
  const [composerHintNonce, setComposerHintNonce] = useState(0)
  const [showPrivacyNotice, setShowPrivacyNotice] = useState(false)
  const [installPrompt, setInstallPrompt] =
    useState<DeferredInstallPromptEvent | null>(null)
  const [installingApp, setInstallingApp] = useState(false)
  const [reminderPanelOpen, setReminderPanelOpen] = useState(false)
  const [skillCenterOpen, setSkillCenterOpen] = useState(false)
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false)
  const [reminderOpenCount, setReminderOpenCount] = useState(0)
  const [authState, setAuthState] = useState<
    'checking' | 'need-login' | 'ready'
  >('checking')
  const [username, setUsername] = useState('')

  useEffect(() => {
    setUnauthorizedHandler(() => setAuthState('need-login'))
    return () => setUnauthorizedHandler(null)
  }, [])

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const status = await api.authStatus()
        if (!alive) return
        setUsername(status.user_id || '')
        setAuthState(status.authenticated ? 'ready' : 'need-login')
      } catch {
        if (alive) setAuthState('need-login')
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    if (authState !== 'ready') return
    void wb.bootstrap()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- boot once per login
  }, [authState])

  async function handleLoggedIn() {
    try {
      const status = await api.authStatus()
      setUsername(status.user_id || '')
    } catch {
      /* 忽略：进入后仍可正常使用 */
    }
    setAuthState('ready')
  }

  async function handleLogout() {
    try {
      await api.authLogout()
    } catch {
      /* 忽略：本地清理即可 */
    }
    setShowAbout(false)
    setUsername('')
    setAuthState('need-login')
  }

  useEffect(() => {
    if (!sessionsOpen) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSessionsOpen(false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [sessionsOpen])

  const modelShort = wb.health?.model
    ? wb.health.model.replace(/^doubao-/, '').slice(0, 22)
    : ''
  const isDemo =
    !!wb.health &&
    (wb.health.provider === 'demo' || wb.health.configured === false)
  const providerLabel = isDemo
    ? '演示模式'
    : wb.health?.provider_label
      ? `${wb.health.provider_label.split('（')[0]} · ${modelShort || '已接入'}`
      : wb.health?.provider
        ? `${wb.health.provider} · ${modelShort || '已接入'}`
        : '演示模式'

  const isDocsChat = wb.moduleAvailable
  const isReminderMode = reminderPanelOpen
  const lastReminderWrite = [...wb.messages]
    .reverse()
    .find((m) => m.role === 'assistant' && m.agent?.wrote_reminders)

  async function refreshReminderStats() {
    try {
      const [allList, due] = await Promise.all([
        api.listReminders({ includeDone: true }),
        api.dueReminders({ withinDays: 30 }),
      ])
      setReminderOpenCount(allList.filter((item) => !item.done).length)
      await maybeNotifyDue(due.items)
    } catch {
      /* 统计失败不阻断主界面 */
    }
  }

  useEffect(() => {
    if (authState !== 'ready' || !wb.moduleAvailable) return
    void refreshReminderStats()
    const timer = window.setInterval(() => {
      void refreshReminderStats()
    }, 15000)
    return () => window.clearInterval(timer)
  }, [authState, wb.moduleAvailable])

  useEffect(() => {
    if (!lastReminderWrite) return
    setReminderPanelOpen(true)
    void refreshReminderStats()
  }, [lastReminderWrite?.id])

  useEffect(() => {
    const onBeforeInstallPrompt = (event: Event) => {
      event.preventDefault()
      setInstallPrompt(event as DeferredInstallPromptEvent)
    }
    const onInstalled = () => {
      setInstallPrompt(null)
      setInstallingApp(false)
    }
    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt)
    window.addEventListener('appinstalled', onInstalled)
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt)
      window.removeEventListener('appinstalled', onInstalled)
    }
  }, [])

  async function installApp() {
    if (!installPrompt) return
    setInstallingApp(true)
    try {
      await installPrompt.prompt()
      await installPrompt.userChoice
    } finally {
      setInstallingApp(false)
      setInstallPrompt(null)
    }
  }

  function applyQuickTask(hint: string, wantPrivacyNotice = false) {
    setComposerHint(hint.trim())
    setComposerHintNonce((v) => v + 1)
    setShowPrivacyNotice(wantPrivacyNotice)
  }

  function closeSessionsSoon() {
    setSessionsOpen(false)
  }

  if (authState === 'checking') {
    return (
      <div className="auth-screen">
        <p className="muted">正在检查登录状态…</p>
      </div>
    )
  }

  if (authState === 'need-login') {
    return (
      <LoginPage
        onDone={() => void handleLoggedIn()}
      />
    )
  }

  return (
    <div
      className={`app-shell${sessionsOpen ? ' sessions-open' : ''}${mobileMore ? ' more-open' : ''}${sessionListCollapsed ? ' sessions-collapsed' : ''}`}
    >
      <ModuleRail
        modules={wb.modules}
        activeModuleId={wb.activeModuleId}
        reminderOpen={isReminderMode}
        reminderCount={reminderOpenCount}
        onToggleReminder={() => {
          setMobileMore(false)
          closeSessionsSoon()
          setReminderPanelOpen(true)
        }}
        onSelect={(id) => {
          setMobileMore(false)
          closeSessionsSoon()
          setReminderPanelOpen(false)
          void wb.setModule(id)
        }}
      />
      {sessionsOpen && !isReminderMode && (
        <button
          type="button"
          className="sessions-backdrop"
          aria-label="关闭记录"
          onClick={closeSessionsSoon}
        />
      )}
      {!isReminderMode && (
        <SessionList
          sessions={wb.sessions}
          currentId={wb.currentSessionId}
          collapsed={sessionListCollapsed}
          onToggleCollapse={() => setSessionListCollapsed((v) => !v)}
          onSelect={(id) => {
            void wb.selectSession(id)
            closeSessionsSoon()
          }}
          onCreate={() => {
            wb.createSession()
            closeSessionsSoon()
          }}
          onRemove={(id) => void wb.removeSession(id)}
          createDisabled={!wb.moduleAvailable}
          createLabel="新对话"
          username={username || '用户'}
          onOpenModelSettings={() => setShowModelSettings(true)}
          onOpenPrivacy={() => setShowAbout(true)}
          onOpenSkills={() => setSkillCenterOpen(true)}
          onOpenDiagnostics={() => setDiagnosticsOpen(true)}
          onInstall={installPrompt ? () => void installApp() : undefined}
          installingApp={installingApp}
          onLogout={() => void handleLogout()}
        />
      )}
      <main className="main-pane">
        {isReminderMode ? (
          <ReminderBoard categoryLabel="提醒面板" />
        ) : wb.bootError ? (
          <div className="boot-error">
            <strong>后端未就绪</strong>
            <p>{wb.bootError}</p>
            <p className="muted">
              在 <code>server/</code> 执行：
              <code>python3 -m uvicorn main:app --reload --port 8000</code>
            </p>
            <button
              type="button"
              className="btn primary"
              onClick={() => void wb.bootstrap()}
            >
              重试连接
            </button>
          </div>
        ) : (
          <>
            <header className="main-head">
              <div className="main-head-lead">
                <button
                  type="button"
                  className="btn ghost mobile-only sessions-toggle"
                  onClick={() => {
                    setMobileMore(false)
                    setSessionsOpen((v) => !v)
                  }}
                  aria-expanded={sessionsOpen}
                  title="对话记录"
                >
                  记录
                </button>
                {sessionListCollapsed && (
                  <button
                    type="button"
                    className="session-expand-inline desktop-only"
                    onClick={() => setSessionListCollapsed(false)}
                    title="展开记录区"
                    aria-label="展开记录区"
                  >
                    <span className="session-nav-icon is-expand" aria-hidden />
                  </button>
                )}
                <div className="main-head-titles">
                  <div className="session-name">青柠 · 生活助理 Agent</div>
                  <p className="workspace-greeting">
                    今天想聊什么，或者想先处理哪件事？
                  </p>
                  <span
                    className="provider-badge mobile-only header-model"
                    data-provider={wb.health?.provider || 'demo'}
                    title={providerLabel}
                    role="status"
                  >
                    <span className="dot" />
                    {providerLabel}
                  </span>
                </div>
              </div>
              <button
                type="button"
                className="btn ghost mobile-only more-toggle"
                aria-expanded={mobileMore}
                onClick={() => setMobileMore((v) => !v)}
              >
                {mobileMore ? '收起' : '更多'}
              </button>
              <div className="head-actions">
                <div className="mobile-only"><ThemeSwitcher /></div>
                {installPrompt && (
                  <button
                    type="button"
                    className="btn ghost"
                    onClick={() => void installApp()}
                    title="安装青柠到桌面或 Dock"
                  >
                    {installingApp ? '安装中…' : '安装应用'}
                  </button>
                )}
                <button
                  type="button"
                  className="btn ghost mobile-only"
                  onClick={() => {
                    setMobileMore(false)
                    setShowAbout(true)
                  }}
                  title="隐私与使用说明"
                >
                  隐私说明
                </button>
                <button
                  type="button"
                  className="btn ghost mobile-only"
                  onClick={() => {
                    setMobileMore(false)
                    setShowModelSettings(true)
                  }}
                  title="选择提供商，Key 只存本机后端"
                >
                  模型设置
                </button>
                <span
                  className="provider-badge desktop-only"
                  data-provider={wb.health?.provider || 'demo'}
                  title={providerLabel}
                  role="status"
                >
                  <span className="dot" />
                  {providerLabel}
                </span>
              </div>
            </header>

            <CompatBanner />

            {isDemo && isDocsChat && (
              <ActionBanner
                kind="warn"
                title="当前为演示模式"
                detail="未配置可用的 API Key。回复为本地占位。可点「模型设置」填入密钥（只存本机），或在 server/.env 配置后重启后端。"
                actions={[
                  {
                    label: '打开模型设置',
                    onClick: () => setShowModelSettings(true),
                  },
                ]}
              />
            )}

            {wb.actionError && (
              <ActionBanner
                kind="error"
                title="操作未成功"
                detail={wb.actionError}
                onDismiss={wb.clearActionError}
                actions={[
                  {
                    label: '重试连接后端',
                    onClick: () => {
                      wb.clearActionError()
                      void wb.bootstrap()
                    },
                  },
                ]}
              />
            )}

            {isDocsChat && (
              <>
                <MessageArea
                  messages={wb.messages}
                  loading={wb.loading}
                  noSession={!wb.currentSessionId}
                  emptyHeader={
                    !wb.messages.length ? (
                      <ScenarioBar
                        disabled={wb.isStreaming}
                        onSelect={(task) => {
                          applyQuickTask(task.hint, !!task.showPrivacyNotice)
                        }}
                      />
                    ) : undefined
                  }
                  onRetry={(id) => wb.retry(id)}
                  onAgentStep={(messageId, stepIndex, action) =>
                    wb.actOnAgentStep(messageId, stepIndex, action)
                  }
                />
                <InputArea
                  disabled={false}
                  streaming={wb.isStreaming}
                  placeholder={wb.activeScenario?.placeholder}
                  seedText={composerHint}
                  seedNonce={composerHintNonce}
                  showPrivacyNotice={showPrivacyNotice}
                  moduleId={wb.activeModuleId}
                  scenarioId={wb.activeScenarioId}
                  allowUpload={wb.activeModuleId === 'docs'}
                  demoMode={isDemo}
                  onSend={(p) => wb.send(p)}
                  onCancel={() => void wb.cancel()}
                />
              </>
            )}
          </>
        )}
      </main>
      <QingningPet onOpenChat={() => setPetChatOpen(true)} />
      <PetChatDrawer
        open={petChatOpen}
        onClose={() => setPetChatOpen(false)}
      />
      <SkillCenter open={skillCenterOpen} onClose={() => setSkillCenterOpen(false)} />
      <DiagnosticsDrawer open={diagnosticsOpen} onClose={() => setDiagnosticsOpen(false)} />
      <AboutDrawer
        open={showAbout}
        onClose={() => setShowAbout(false)}
        onLogout={() => void handleLogout()}
        username={username}
        onDataRestored={() => void wb.bootstrap()}
      />
      <ModelSettingsDrawer
        open={showModelSettings}
        onClose={() => setShowModelSettings(false)}
        onSaved={() => wb.refreshHealth()}
      />
    </div>
  )
}
