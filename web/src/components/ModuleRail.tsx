import type { AppModule } from '../types'
import { BrandMark } from './BrandMark'

interface Props {
  modules: AppModule[]
  activeModuleId: string
  onSelect: (moduleId: string) => void
  reminderOpen: boolean
  reminderCount: number
  onToggleReminder: () => void
}

export function ModuleRail({
  modules,
  activeModuleId,
  onSelect,
  reminderOpen,
  reminderCount,
  onToggleReminder,
}: Props) {
  const workspace = modules[0]

  return (
    <nav className="module-rail" aria-label="生活助理工作台">
      <div className="rail-brand" title="青柠">
        <BrandMark className="sm" />
      </div>
      {workspace ? (
        <div className="rail-mods">
          <button
            type="button"
            className={`rail-item workspace ${workspace.id === activeModuleId && !reminderOpen ? 'active' : ''}`}
            onClick={() => onSelect(workspace.id)}
            title={workspace.blurb}
          >
            <span className="rail-icon" aria-hidden>
              青
            </span>
            <span className="rail-label">工作台</span>
          </button>
          <button
            type="button"
            className={`rail-item reminder${reminderOpen ? ' active' : ''}`}
            onClick={onToggleReminder}
            title="切换到提醒面板"
          >
            <span className="rail-icon" aria-hidden>
              记
            </span>
            <span className="rail-label">提醒</span>
            <span className="rail-badge">{reminderCount}</span>
          </button>
        </div>
      ) : null}
    </nav>
  )
}
