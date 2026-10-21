import type { AppModule } from '../types'
import { BrandMark } from './BrandMark'

interface Props {
  modules: AppModule[]
  activeModuleId: string
  onSelect: (moduleId: string) => void
}

export function ModuleRail({ modules, activeModuleId, onSelect }: Props) {
  return (
    <nav className="module-rail" aria-label="功能模块">
      <div className="rail-brand" title="青柠">
        <BrandMark className="sm" />
      </div>
      <div className="rail-mods">
        {modules.map((m) => {
          const active = m.id === activeModuleId
          const soon = m.status === 'coming_soon'
          return (
            <button
              key={m.id}
              type="button"
              className={`rail-item ${active ? 'active' : ''} ${soon ? 'soon' : ''}`}
              onClick={() => onSelect(m.id)}
              title={soon ? `${m.name}（即将开放）` : m.blurb}
            >
              <span className="rail-icon" aria-hidden>
                {m.id === 'docs' ? '文' : '提'}
              </span>
              <span className="rail-label">{m.name}</span>
              {soon && <span className="rail-tag">Soon</span>}
            </button>
          )
        })}
      </div>
    </nav>
  )
}
