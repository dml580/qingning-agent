import type { Session } from '../types'
import { BrandMark } from './BrandMark'
import { UserProfileMenu } from './UserProfileMenu'

interface Props {
  sessions: Session[]
  currentId: string | null
  onSelect: (id: string) => void
  onCreate: () => void
  onRemove: (id: string) => void | Promise<void>
  collapsed?: boolean
  onToggleCollapse?: () => void
  createDisabled?: boolean
  createLabel?: string
  /** 非对话模块时的侧栏说明 */
  modeHint?: string
  username: string
  onOpenModelSettings: () => void
  onOpenPrivacy: () => void
  onOpenSkills: () => void
  onInstall?: () => void
  installingApp?: boolean
  onLogout: () => void
}

function formatTime(ts: number) {
  const d = new Date(ts * 1000)
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export function SessionList({
  sessions,
  currentId,
  onSelect,
  onCreate,
  onRemove,
  collapsed = false,
  onToggleCollapse,
  createDisabled,
  createLabel = '新对话',
  modeHint,
  username,
  onOpenModelSettings,
  onOpenPrivacy,
  onOpenSkills,
  onInstall,
  installingApp,
  onLogout,
}: Props) {
  function confirmRemove(id: string, title: string) {
    const ok = window.confirm(
      [
        '确定删除这条记录？',
        '',
        `「${title || '未命名记录'}」及其全部消息将从本机数据库永久清除，无法恢复。`,
      ].join('\n'),
    )
    if (!ok) return
    void onRemove(id)
  }

  return (
    <aside className={`session-list${collapsed ? ' is-collapsed' : ''}`}>
      <div className="session-head">
        <div className="session-head-row">
          <div className="brand with-logo">
            <BrandMark />
            <div className="brand-copy">
              <h1>青柠</h1>
              <p className="brand-sub">生活助理 Agent</p>
            </div>
          </div>
          {onToggleCollapse && (
            <button
              type="button"
              className="session-collapse-btn"
              onClick={onToggleCollapse}
              title={collapsed ? '展开记录区' : '收起记录区'}
              aria-label={collapsed ? '展开记录区' : '收起记录区'}
            >
              <span
                className={`session-nav-icon ${collapsed ? 'is-expand' : 'is-collapse'}`}
                aria-hidden
              />
            </button>
          )}
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
      <ul>
        {sessions.map((s) => (
          <li
            key={s.id}
            className={s.id === currentId ? 'active' : undefined}
            onClick={() => onSelect(s.id)}
          >
            <div className="session-title">{s.title}</div>
            <div className="session-meta">
              <span>{formatTime(s.updated_at)}</span>
              <button
                type="button"
                className="link"
                title="删除这条记录"
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
              {modeHint ? '无需记录' : '还没有记录'}
            </div>
            <p className="session-empty-hint">
              {modeHint ||
                '发送一条消息后，这条对话会出现在这里。删除只去掉对应的一条。'}
            </p>
          </li>
        )}
      </ul>
      <UserProfileMenu
        username={username}
        onOpenModelSettings={onOpenModelSettings}
        onOpenPrivacy={onOpenPrivacy}
        onOpenSkills={onOpenSkills}
        onInstall={onInstall}
        installingApp={installingApp}
        onLogout={onLogout}
      />
    </aside>
  )
}
