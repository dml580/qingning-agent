import { useEffect, useState } from 'react'
import { InputArea } from './components/InputArea'
import { MessageArea } from './components/MessageArea'
import { ModuleRail } from './components/ModuleRail'
import { QingningPet } from './components/QingningPet'
import { ScenarioBar } from './components/ScenarioBar'
import { SessionList } from './components/SessionList'
import { useWorkbench } from './context/WorkbenchContext'
import './App.css'

export default function App() {
  const wb = useWorkbench()
  const [showPerf, setShowPerf] = useState(false)

  useEffect(() => {
    void wb.bootstrap()
    // eslint-disable-next-line react-hooks/exhaustive-deps -- boot once
  }, [])

  const modelShort = wb.health?.model
    ? wb.health.model.replace(/^doubao-/, '').slice(0, 22)
    : ''
  const providerLabel =
    wb.health?.provider === 'doubao'
      ? `豆包 · ${modelShort || '已接入'}`
      : '演示模式'

  const scenarioNameById = (scenarioId: string) =>
    wb.activeModule?.scenarios.find((s) => s.id === scenarioId)?.name ||
    scenarioId

  return (
    <div className="app-shell">
      <ModuleRail
        modules={wb.modules}
        activeModuleId={wb.activeModuleId}
        onSelect={(id) => void wb.setModule(id)}
      />
      <SessionList
        sessions={wb.sessions}
        currentId={wb.currentSessionId}
        scenarioLabel={(s) => scenarioNameById(s.scenario_id)}
        onSelect={(id) => void wb.selectSession(id)}
        onCreate={() => void wb.createSession()}
        onRemove={(id) => void wb.removeSession(id)}
        createDisabled={!wb.moduleAvailable}
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
          </div>
        ) : (
          <>
            <header className="main-head">
              <div>
                <div className="crumb">
                  <span>{wb.activeModule?.name || '模块'}</span>
                  {wb.moduleAvailable && wb.activeScenario && (
                    <>
                      <span className="crumb-sep">/</span>
                      <span className="crumb-now">{wb.activeScenario.name}</span>
                    </>
                  )}
                </div>
                <div className="session-name">
                  {wb.moduleAvailable
                    ? wb.currentSession?.title || '新会话（发送后自动创建）'
                    : '板块尚未开放'}
                </div>
                <div className="stream-pill" data-status={wb.streamStatus}>
                  流状态：{wb.streamStatus}
                </div>
              </div>
              <div className="head-actions">
                {wb.moduleAvailable && (
                  <button
                    type="button"
                    className={`btn ghost ${showPerf ? 'active' : ''}`}
                    onClick={() => setShowPerf((v) => !v)}
                    title="面试对比用：节点数 / FPS"
                  >
                    {showPerf ? '收起对比' : '虚拟列表对比'}
                  </button>
                )}
                <div
                  className="provider-badge"
                  data-provider={wb.health?.provider || 'demo'}
                >
                  <span className="dot" />
                  {providerLabel}
                </div>
              </div>
            </header>

            <ScenarioBar
              module={wb.activeModule}
              scenarioId={wb.activeScenarioId}
              onSelect={(id) => void wb.setScenario(id)}
              disabled={wb.isStreaming}
            />

            {wb.moduleAvailable && (
              <>
                <MessageArea
                  messages={wb.messages}
                  loading={wb.loading}
                  onRetry={(id) => void wb.retry(id)}
                  showPerf={showPerf}
                />
                <InputArea
                  disabled={false}
                  streaming={wb.isStreaming}
                  placeholder={wb.activeScenario?.placeholder}
                  moduleId={wb.activeModuleId}
                  scenarioId={wb.activeScenarioId}
                  allowUpload={wb.activeModuleId === 'docs'}
                  onSend={(p) => wb.send(p)}
                  onCancel={() => void wb.cancel()}
                />
              </>
            )}
          </>
        )}
      </main>
      <QingningPet />
    </div>
  )
}
