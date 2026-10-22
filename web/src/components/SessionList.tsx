import type { Session } from '../types'
import type { ScenarioSlot } from '../context/WorkbenchContext'
import { BrandMark } from './BrandMark'

interface Props {
  sessions: Session[]
  currentId: string | null
  /** 文书模块：按模版分槽，一模版一行 */
  scenarioSlots?: ScenarioSlot[] | null
  activeScenarioId?: string
  scenarioLabel?: (s: Session) => string
  onSelect: (id: string) => void
  /** 点击尚无会话的模版槽 */
  onOpenScenario?: (scenarioId: string) => void
  onCreate: () => void
  onRemove: (id: string) => void | Promise<void>
  createDisabled?: boolean
  createLabel?: string
  /** 非会话模块时的侧栏说明 */
  modeHint?: string
}

function formatTime(ts: number) {
  const d = new Date(ts * 1000)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function SessionList({
  sessions,
  currentId,
  scenarioSlots,
  activeScenarioId,
  scenarioLabel,
  onSelect,
  onOpenScenario,
  onCreate,
  onRemove,
  createDisabled,
  createLabel = '新建会话',
  modeHint,
}: Props) {
  function confirmRemove(id: string, title: string) {
    const ok = window.confirm(
      [
        '确定删除该会话？',
        '',
        `「${title || '未命名会话'}」及其全部消息将从本机数据库永久清除，无法恢复。`,
      ].join('\n'),
    )
    if (!ok) return
    void onRemove(id)
  }

  const byScenario = !!scenarioSlots?.length

  return (
    <aside className="session-list">
      <div className="session-head">
        <div className="brand with-logo">
          <BrandMark />
          <div className="brand-copy">
            <h1>青柠</h1>
            <p className="brand-sub">生活文书工作台</p>
          </div>
        </div>
        <button
          type="button"
          className="btn primary"
          disabled={createDisabled}
          onClick={onCreate}
        >
          {createLabel}
        </button>
      </div>
      {byScenario ? (
        <ul className="session-slots">
          {scenarioSlots!.map((slot) => {
            const active = slot.scenarioId === activeScenarioId
            const sid = slot.session?.id
            return (
              <li
                key={slot.scenarioId}
                className={active ? 'active' : undefined}
                onClick={() => {
                  if (sid) onSelect(sid)
                  else onOpenScenario?.(slot.scenarioId)
                }}
              >
                <div className="session-title">{slot.name}</div>
                <div className="session-meta">
                  <span>
                    {slot.session
                      ? formatTime(slot.session.updated_at)
                      : '尚未开始'}
                  </span>
                  {sid ? (
                    <button
                      type="button"
                      className="link"
                      title="删除该模版对话"
                      onClick={(e) => {
                        e.stopPropagation()
                        confirmRemove(sid, slot.name)
                      }}
                    >
                      删除
                    </button>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
      ) : (
        <ul>
          {sessions.map((s) => (
            <li
              key={s.id}
              className={s.id === currentId ? 'active' : undefined}
              onClick={() => onSelect(s.id)}
            >
              <div className="session-title">{s.title}</div>
              <div className="session-meta">
                <span>
                  {scenarioLabel?.(s) ? `${scenarioLabel(s)} · ` : ''}
                  {formatTime(s.updated_at)}
                </span>
                <button
                  type="button"
                  className="link"
                  title="删除会话（本机永久清除）"
                  onClick={(e) => {
                    e.stopPropagation()
                    confirmRemove(s.id, s.title)
                  }}
                >
                  删除
                </button>
              </div>
            </li>
          ))}
          {!sessions.length && (
            <li className="empty">
              <div className="session-empty-title">
                {modeHint ? '无需会话' : '当前板块还没有会话'}
              </div>
              <p className="session-empty-hint">
                {modeHint ||
                  '点上方「新建会话」，或直接在右侧发送消息自动创建。删除会话会同步清掉本机 SQLite 中的记录。'}
              </p>
            </li>
          )}
        </ul>
      )}
    </aside>
  )
}
