import type { AppModule, Scenario } from '../types'

interface Props {
  module: AppModule | null
  scenarioId: string
  onSelect: (scenarioId: string) => void
  disabled?: boolean
}

export function ScenarioBar({
  module,
  scenarioId,
  onSelect,
  disabled,
}: Props) {
  if (!module) return null

  if (module.status === 'coming_soon') {
    return (
      <div className="scenario-bar coming">
        <div className="scenario-coming-card">
          <h3>{module.name} · 即将开放</h3>
          <p>{module.blurb}</p>
          <ul>
            {module.scenarios.map((s: Scenario) => (
              <li key={s.id}>
                <strong>{s.name}</strong>
                <span>{s.blurb}</span>
              </li>
            ))}
          </ul>
          <p className="muted tip">先用左侧「生活文书」分析合同与通知。</p>
        </div>
      </div>
    )
  }

  const visible = module.scenarios.filter((s) => !s.hidden && s.id !== 'companion')

  return (
    <div className="scenario-bar" role="tablist" aria-label="文书模版">
      {visible.map((s) => (
        <button
          key={s.id}
          type="button"
          role="tab"
          aria-selected={s.id === scenarioId}
          className={`scenario-chip ${s.id === scenarioId ? 'active' : ''}`}
          disabled={disabled}
          title={s.blurb}
          onClick={() => onSelect(s.id)}
        >
          <span className="chip-name">{s.name}</span>
          <span className="chip-blurb">{s.blurb}</span>
        </button>
      ))}
    </div>
  )
}
