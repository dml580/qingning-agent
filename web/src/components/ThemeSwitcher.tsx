import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
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
  const [open, setOpen] = useState(false)
  const current = THEME_OPTIONS.find((opt) => opt.id === theme) ?? THEME_OPTIONS[0]

  useEffect(() => {
    applyTheme(theme)
  }, [theme])

  return (
    <div className="theme-switcher" role="group" aria-label="切换主题颜色">
      <button
        type="button"
        className="theme-menu-row mobile-only"
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <span>主题切换</span>
        <span className="theme-menu-current">
          {current.label}
          <span className="theme-menu-chevron" aria-hidden>
            ›
          </span>
        </span>
      </button>
      <div className="theme-options">
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
      {open &&
        createPortal(
        <div
          className="about-overlay"
          role="presentation"
          onClick={() => setOpen(false)}
        >
          <aside
            className="about-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby="theme-drawer-title"
            onClick={(e) => e.stopPropagation()}
          >
            <header className="about-head">
              <h2 id="theme-drawer-title">主题切换</h2>
              <button
                type="button"
                className="btn ghost small"
                onClick={() => setOpen(false)}
              >
                关闭
              </button>
            </header>
            <div className="about-body theme-drawer-body">
              {THEME_OPTIONS.map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  className={`theme-choice${theme === opt.id ? ' active' : ''}`}
                  aria-pressed={theme === opt.id}
                  onClick={() => setTheme(opt.id)}
                >
                  <span
                    className={`theme-swatch theme-swatch-${opt.id}`}
                    aria-hidden
                  />
                  <span className="theme-choice-copy">
                    <strong>{opt.label}</strong>
                    <span>{opt.title}</span>
                  </span>
                  {theme === opt.id && (
                    <span className="theme-choice-mark" aria-hidden>
                      当前
                    </span>
                  )}
                </button>
              ))}
            </div>
          </aside>
        </div>,
          document.body,
        )}
    </div>
  )
}
