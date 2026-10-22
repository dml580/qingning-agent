import { useEffect, useState } from 'react'
import {
  THEME_OPTIONS,
  applyTheme,
  readTheme,
  type ThemeId,
} from '../theme'

export function ThemeSwitcher() {
  const [theme, setTheme] = useState<ThemeId>(() =>
    typeof document !== 'undefined' ? readTheme() : 'ink',
  )

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  return (
    <div className="theme-switcher" role="group" aria-label="切换主题颜色">
      {THEME_OPTIONS.map((opt) => (
        <button
          key={opt.id}
          type="button"
          className={`theme-chip${theme === opt.id ? ' active' : ''}`}
          title={opt.title}
          aria-pressed={theme === opt.id}
          onClick={() => setTheme(opt.id)}
        >
          <span className={`theme-swatch theme-swatch-${opt.id}`} aria-hidden />
          <span className="theme-chip-label">{opt.label}</span>
        </button>
      ))}
    </div>
  )
}
