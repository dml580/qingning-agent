export type ThemeId = 'ink' | 'dark' | 'light'

export const THEME_OPTIONS: { id: ThemeId; label: string; title: string }[] = [
  { id: 'ink', label: '青墨', title: '黑青主题（默认）' },
  { id: 'dark', label: '暗夜', title: '黑色主题' },
  { id: 'light', label: '素白', title: '白色主题' },
]

const STORAGE_KEY = 'qingning-theme'

export function readTheme(): ThemeId {
  try {
    const v = localStorage.getItem(STORAGE_KEY)
    if (v === 'ink' || v === 'dark' || v === 'light') return v
  } catch {
    /* ignore */
  }
  return 'ink'
}

export function applyTheme(id: ThemeId) {
  document.documentElement.setAttribute('data-theme', id)
  try {
    localStorage.setItem(STORAGE_KEY, id)
  } catch {
    /* ignore */
  }
}
