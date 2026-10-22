import { useEffect, useState } from 'react'
import { AboutDrawer } from './components/AboutDrawer'
import { ActionBanner } from './components/ActionBanner'
import { CompatBanner } from './components/CompatBanner'
import { InputArea } from './components/InputArea'
import { MessageArea } from './components/MessageArea'
import { ModelSettingsDrawer } from './components/ModelSettingsDrawer'
import { ModuleRail } from './components/ModuleRail'
import { PetChatDrawer } from './components/PetChatDrawer'
import { QingningPet } from './components/QingningPet'
import { ReminderBoard } from './components/ReminderBoard'
import { ScenarioBar } from './components/ScenarioBar'
import { SessionList } from './components/SessionList'
import { ThemeSwitcher } from './components/ThemeSwitcher'
import { useWorkbench } from './context/WorkbenchContext'
import './App.css'

export default function App() {
  const wb = useWorkbench()
  const [showPerf, setShowPerf] = useState(false)
  const [showAbout, setShowAbout] = useState(false)
  const [showModelSettings, setShowModelSettings] = useState(false)
  const [sessionsOpen, setSessionsOpen] = useState(false)
  const [petChatOpen, setPetChatOpen] = useState(false)

  useEffect(() => {
    void wb.bootstrap()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- boot once
  }, [])

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

  const scenarioNameById = (scenarioId: string) =>
    wb.activeModule?.scenarios.find((s) => s.id === scenarioId)?.name ||
    scenarioId

  const isReminders = wb.activeModuleId === 'reminders'
  const isDocsChat = wb.moduleAvailable && !isReminders

  function closeSessionsSoon() {
    setSessionsOpen(false)
  }

  return (
    <div
      className={`app-shell${sessionsOpen ? ' sessions-open' : ''}${isReminders ? ' mode-reminders' : ''}`}
    >
      <ModuleRail
        modules={wb.modules}
        activeModuleId={wb.activeModuleId}
        onSelect={(id) => void wb.setModule(id)}
      />
      {sessionsOpen && (
        <button
          type="button"
          className="sessions-backdrop"
          aria-label="关闭会话列表"
          onClick={closeSessionsSoon}
        />
      )}
      <SessionList
        sessions={wb.sessions}
        currentId={wb.currentSessionId}
        scenarioSlots={isDocsChat ? wb.scenarioSlots : null}
        activeScenarioId={wb.activeScenarioId}
        scenarioLabel={(s) => scenarioNameById(s.scenario_id)}
        onSelect={(id) => {
          void wb.selectSession(id)
          closeSessionsSoon()
        }}
        onOpenScenario={(scenarioId) => {
          void wb.setScenario(scenarioId)
          closeSessionsSoon()
        }}
        onCreate={() => {
          void wb.createSession()
          closeSessionsSoon()
        }}
        onRemove={(id) => void wb.removeSession(id)}
        createDisabled={!wb.moduleAvailable || isReminders}
        createLabel={isDocsChat ? '重新开始本模版' : '新建会话'}
        modeHint={
          isReminders
            ? '生活提醒使用右侧看板，不占用会话列表。数据保存在本机。'
            : undefined
        }
      />
      <main className="main-pane">
        {wb.bootError ? (
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
                  onClick={() => setSessionsOpen((v) => !v)}
                  aria-expanded={sessionsOpen}
                  title="会话列表"
                >
                  会话
                </button>
                <div className="main-head-titles">
                  <div className="crumb">
                    <span>{wb.activeModule?.name || '模块'}</span>
                    {wb.moduleAvailable && wb.activeScenario && (
                      <>
                        <span className="crumb-sep">/</span>
                        <span className="crumb-now">
                          {wb.activeScenario.name}
                        </span>
                      </>
                    )}
                  </div>
                  <div className="session-name">
                  {isReminders
                    ? '打开即见到期项 · 可选电脑通知'
                    : wb.moduleAvailable
                      ? wb.currentSession?.title || '新会话（发送后自动创建）'
                      : '板块尚未开放'}
                </div>
                {isDocsChat && (
                  <div className="stream-pill" data-status={wb.streamStatus}>
                    流状态：{wb.streamStatus}
                  </div>
                )}
                </div>
              </div>
              <div className="head-actions">
                <ThemeSwitcher />
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => setShowAbout(true)}
                  title="隐私与使用说明"
                >
                  隐私说明
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => setShowModelSettings(true)}
                  title="选择提供商，Key 只存本机后端"
                >
                  模型设置
                </button>
                {isDocsChat && (
                  <button
                    type="button"
                    className={`btn ghost desktop-only ${showPerf ? 'active' : ''}`}
                    onClick={() => setShowPerf((v) => !v)}
                    title="面试对比用：节点数 / FPS"
                  >
                    {showPerf ? '收起对比' : '虚拟列表对比'}
                  </button>
                )}
                <button
                  type="button"
                  className="provider-badge"
                  data-provider={wb.health?.provider || 'demo'}
                  onClick={() => setShowModelSettings(true)}
                  title="打开模型设置"
                >
                  <span className="dot" />
                  {providerLabel}
                </button>
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

            <ScenarioBar
              module={wb.activeModule}
              scenarioId={wb.activeScenarioId}
              onSelect={(id) => void wb.setScenario(id)}
              disabled={wb.isStreaming}
            />

            {isReminders && wb.moduleAvailable && (
              <ReminderBoard
                category={wb.activeScenarioId}
                categoryLabel={wb.activeScenario?.name || '提醒'}
              />
            )}

            {isDocsChat && (
              <>
                <MessageArea
                  messages={wb.messages}
                  loading={wb.loading}
                  noSession={!wb.currentSessionId}
                  onRetry={(id) => wb.retry(id)}
                  showPerf={showPerf}
                />
                <InputArea
                  disabled={false}
                  streaming={wb.isStreaming}
                  placeholder={wb.activeScenario?.placeholder}
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
      <AboutDrawer open={showAbout} onClose={() => setShowAbout(false)} />
      <ModelSettingsDrawer
        open={showModelSettings}
        onClose={() => setShowModelSettings(false)}
        onSaved={() => wb.refreshHealth()}
      />
    </div>
  )
}
