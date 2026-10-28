import { useEffect, useRef, useState } from 'react'
import { THEME_OPTIONS, applyTheme, readTheme, type ThemeId } from '../theme'

interface Props {
  username: string
  onOpenModelSettings: () => void
  onOpenPrivacy: () => void
  onOpenSkills: () => void
  onInstall?: () => void
  installingApp?: boolean
  onLogout: () => void
}

function avatarText(username: string) {
  return Array.from(username.trim())[0]?.toUpperCase() || '用'
}

export function UserProfileMenu({
  username,
  onOpenModelSettings,
  onOpenPrivacy,
  onOpenSkills,
  onInstall,
  installingApp,
  onLogout,
}: Props) {
  const [open, setOpen] = useState(false)
  const [themeOpen, setThemeOpen] = useState(false)
  const [theme, setTheme] = useState<ThemeId>(() => readTheme())
  const rootRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const closeOnOutside = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setThemeOpen(false)
        setOpen(false)
      }
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (themeOpen) setThemeOpen(false)
        else setOpen(false)
      }
    }
    document.addEventListener('mousedown', closeOnOutside)
    window.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('mousedown', closeOnOutside)
      window.removeEventListener('keydown', closeOnEscape)
    }
  }, [open, themeOpen])

  const run = (action: () => void) => {
    setOpen(false)
    setThemeOpen(false)
    action()
  }

  const chooseTheme = (nextTheme: ThemeId) => {
    setTheme(nextTheme)
    applyTheme(nextTheme)
    setThemeOpen(false)
  }

  const currentTheme = THEME_OPTIONS.find((option) => option.id === theme)

  return (
    <div className="user-profile" ref={rootRef}>
      {open && (
        <div className="user-menu" role="menu" aria-label="账号与设置">
          <div className="user-menu-heading">账号与设置</div>
          <button type="button" role="menuitem" onClick={() => run(onOpenModelSettings)}>
            <span className="user-menu-icon" aria-hidden>⚙</span>
            <span>模型设置</span>
          </button>
          <button
            type="button"
            role="menuitem"
            className="user-menu-theme-trigger"
            aria-haspopup="menu"
            aria-expanded={themeOpen}
            onClick={() => setThemeOpen((value) => !value)}
          >
            <span className="user-menu-icon" aria-hidden>◐</span>
            <span>主题模式</span>
            <span className="user-menu-theme-current">{currentTheme?.label}</span>
            <span className="user-menu-sub-chevron" aria-hidden>›</span>
          </button>
          {themeOpen && (
            <div className="user-theme-submenu" role="menu" aria-label="选择主题模式">
              {THEME_OPTIONS.map((option) => (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={theme === option.id}
                  className={theme === option.id ? 'active' : undefined}
                  key={option.id}
                  onClick={() => chooseTheme(option.id)}
                >
                  <span className={`theme-swatch theme-swatch-${option.id}`} aria-hidden />
                  <span>{option.label}</span>
                  <span className="user-theme-check" aria-hidden>{theme === option.id ? '✓' : ''}</span>
                </button>
              ))}
            </div>
          )}
          <button type="button" role="menuitem" onClick={() => run(onOpenPrivacy)}>
            <span className="user-menu-icon" aria-hidden>◇</span>
            <span>隐私与使用说明</span>
          </button>
          <button type="button" role="menuitem" onClick={() => run(onOpenSkills)}><span className="user-menu-icon" aria-hidden>◇</span><span>能力管理</span></button>
          {onInstall && (
            <button type="button" role="menuitem" disabled={installingApp} onClick={() => run(onInstall)}>
              <span className="user-menu-icon" aria-hidden>⇩</span>
              <span>{installingApp ? '安装中…' : '安装应用'}</span>
            </button>
          )}
          <div className="user-menu-separator" />
          <button type="button" role="menuitem" className="user-menu-logout" onClick={() => run(onLogout)}>
            <span className="user-menu-icon" aria-hidden>↪</span>
            <span>退出登录</span>
          </button>
        </div>
      )}
      <button
        type="button"
        className="user-profile-trigger"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="user-avatar" aria-hidden>{avatarText(username)}</span>
        <span className="user-profile-name" title={username}>{username}</span>
        <span className="user-profile-chevron" aria-hidden>{open ? '⌄' : '›'}</span>
      </button>
    </div>
  )
}
