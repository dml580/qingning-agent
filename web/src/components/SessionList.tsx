import type { Session } from '../types'
import { BrandMark } from './BrandMark'

interface Props {
  sessions: Session[]
  currentId: string | null
  scenarioLabel?: (s: Session) => string
  onSelect: (id: string) => void
  onCreate: () => void
  onRemove: (id: string) => void
  createDisabled?: boolean
}

function formatTime(ts: number) {
  const d = new Date(ts * 1000)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function SessionList({
  sessions,
  currentId,
  scenarioLabel,
  onSelect,
  onCreate,
  onRemove,
  createDisabled,
}: Props) {
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
          新建会话
        </button>
      </div>
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
                title="删除"
                onClick={(e) => {
                  e.stopPropagation()
                  onRemove(s.id)
                }}
              >
                删除
              </button>
            </div>
          </li>
        ))}
        {!sessions.length && (
          <li className="empty">当前板块还没有会话</li>
        )}
      </ul>
    </aside>
  )
}
