import { useState, type FormEvent } from 'react'
import { api } from '../api/client'
import { BrandMark } from './BrandMark'

interface Props {
  /** 登录 / 设置成功后回调 */
  onDone: () => void
}

/** 统一登录注册入口，始终显示用户名与密码。 */
export function LoginPage({ onDone }: Props) {
  const [password, setPassword] = useState('')
  const [username, setUsername] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)


  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (password.length < 6) {
      setError('密码至少 6 位')
      return
    }
    if (!username.trim()) {
      setError('请输入用户名')
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.authLogin(username.trim(), password)
      setPassword('')
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={onSubmit}>
        <div className="auth-brand">
          <BrandMark className="auth-logo" />
          <div>
            <h1>青柠 · 生活助理 Agent</h1>
            <p className="muted">
              输入用户名和密码，未注册的用户名将自动注册并登录。
            </p>
          </div>
        </div>

        <label className="auth-field">
          <span>用户名</span>
          <input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            placeholder="请输入用户名"
            autoComplete="username"
            maxLength={40}
            required
            autoFocus
          />
        </label>

        <label className="auth-field">
          <span>密码</span>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="至少 6 位"
            required
            minLength={6}
            autoComplete="current-password"
          />
        </label>

        {error && (
          <div className="inline-error" role="alert">
            {error}
          </div>
        )}

        <button
          type="submit"
          className="btn primary auth-submit"
          disabled={busy}
        >
          {busy ? '正在登录…' : '登录 / 注册'}
        </button>

        <p className="muted auth-foot">
          登录状态保持 30 天。已有密码账号请使用用户名 owner 和原密码登录。
        </p>
      </form>
    </div>
  )
}
