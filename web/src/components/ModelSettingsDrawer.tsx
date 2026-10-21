import { useEffect, useState, type FormEvent } from 'react'
import {
  api,
  type LlmProviderInfo,
  type LlmSettingsResponse,
} from '../api/client'

interface Props {
  open: boolean
  onClose: () => void
  onSaved: () => void | Promise<void>
}

export function ModelSettingsDrawer({ open, onClose, onSaved }: Props) {
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [okMsg, setOkMsg] = useState<string | null>(null)
  const [providers, setProviders] = useState<LlmProviderInfo[]>([])
  const [privacyNote, setPrivacyNote] = useState('')
  const [provider, setProvider] = useState('doubao')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [visionModel, setVisionModel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [keyHint, setKeyHint] = useState('')
  const [keySet, setKeySet] = useState(false)
  const [source, setSource] = useState('none')

  useEffect(() => {
    if (!open) return
    setError(null)
    setOkMsg(null)
    setApiKey('')
    setLoading(true)
    void api
      .getLlmSettings()
      .then((data: LlmSettingsResponse) => {
        applySettings(data)
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : '无法加载模型设置')
      })
      .finally(() => setLoading(false))
  }, [open])

  function applySettings(data: LlmSettingsResponse) {
    setProviders(data.providers)
    setPrivacyNote(data.privacy_note)
    const c = data.current
    setProvider(c.provider)
    setModel(c.model)
    setVisionModel(c.vision_model)
    setBaseUrl(c.base_url)
    setKeyHint(c.api_key_hint)
    setKeySet(c.api_key_set)
    setSource(c.source)
  }

  function onProviderChange(id: string) {
    setProvider(id)
    const p = providers.find((x) => x.id === id)
    if (!p) return
    // 切换提供商时填入默认值（不覆盖用户已改的 Key 输入）
    setModel(p.default_model)
    setVisionModel(p.default_model)
    setBaseUrl(p.default_base_url)
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    setSaving(true)
    setError(null)
    setOkMsg(null)
    try {
      const body: {
        provider: string
        model: string
        vision_model: string
        base_url: string
        api_key?: string
      } = {
        provider,
        model: model.trim(),
        vision_model: visionModel.trim() || model.trim(),
        base_url: baseUrl.trim(),
      }
      if (apiKey.trim()) {
        body.api_key = apiKey.trim()
      }
      const data = await api.putLlmSettings(body)
      applySettings(data)
      setApiKey('')
      setOkMsg('已保存到本机后端。新消息将使用当前模型。')
      await onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  async function onResetEnv() {
    const ok = window.confirm(
      '清除页面保存的模型配置，恢复为 server/.env（若未配置则回到演示模式）？',
    )
    if (!ok) return
    setSaving(true)
    setError(null)
    setOkMsg(null)
    try {
      const data = await api.clearLlmSettings()
      applySettings(data)
      setApiKey('')
      setOkMsg('已恢复为环境变量 / 演示模式。')
      await onSaved()
    } catch (err) {
      setError(err instanceof Error ? err.message : '恢复失败')
    } finally {
      setSaving(false)
    }
  }

  if (!open) return null

  const currentMeta = providers.find((p) => p.id === provider)

  return (
    <div className="about-overlay" role="presentation" onClick={onClose}>
      <aside
        className="about-drawer model-settings-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="model-settings-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="about-head">
          <h2 id="model-settings-title">模型设置</h2>
          <button type="button" className="btn ghost small" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="about-body">
          <section className="privacy-callout">
            <h3>隐私</h3>
            <p>
              {privacyNote ||
                'API Key 只保存在本机后端，不会写入前端仓库；请求由本机发出。'}
            </p>
          </section>

          {loading ? (
            <p className="muted">加载中…</p>
          ) : (
            <form className="model-settings-form" onSubmit={onSubmit}>
              <label>
                <span>提供商</span>
                <select
                  value={provider}
                  onChange={(e) => onProviderChange(e.target.value)}
                >
                  {providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.label}
                    </option>
                  ))}
                </select>
              </label>

              {currentMeta?.hint && (
                <p className="field-hint">
                  {currentMeta.hint}
                  {currentMeta.docs_url ? (
                    <>
                      {' '}
                      <a
                        href={currentMeta.docs_url}
                        target="_blank"
                        rel="noreferrer"
                      >
                        打开控制台
                      </a>
                    </>
                  ) : null}
                </p>
              )}

              <label>
                <span>
                  API Key
                  {keySet
                    ? `（已配置 ${keyHint || '••••'}，留空则保留）`
                    : '（必填才能走真模型）'}
                </span>
                <input
                  type="password"
                  autoComplete="off"
                  placeholder={keySet ? '留空保留原 Key' : '粘贴 API Key'}
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                />
              </label>

              <label>
                <span>模型 / 接入点 ID</span>
                <input
                  type="text"
                  value={model}
                  onChange={(e) => setModel(e.target.value)}
                  placeholder="如 ep-xxxx 或 deepseek-chat"
                  required
                />
              </label>

              <label>
                <span>读图模型（可选，默认同上）</span>
                <input
                  type="text"
                  value={visionModel}
                  onChange={(e) => setVisionModel(e.target.value)}
                  placeholder="审核/多模态用"
                />
              </label>

              <label>
                <span>Base URL</span>
                <input
                  type="url"
                  value={baseUrl}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  placeholder="https://…/v1 或 /api/v3"
                  required
                />
              </label>

              <p className="field-hint">
                当前来源：
                {source === 'runtime'
                  ? '页面设置（本机 data/）'
                  : source === 'env'
                    ? '环境变量 .env'
                    : '未配置（演示模式）'}
              </p>

              {error && (
                <div className="inline-error" role="alert">
                  {error}
                </div>
              )}
              {okMsg && <p className="ok-msg">{okMsg}</p>}

              <div className="model-settings-actions">
                <button
                  type="submit"
                  className="btn primary"
                  disabled={saving}
                >
                  {saving ? '保存中…' : '保存到本机'}
                </button>
                <button
                  type="button"
                  className="btn ghost"
                  disabled={saving}
                  onClick={() => void onResetEnv()}
                >
                  恢复为环境变量
                </button>
              </div>
            </form>
          )}
        </div>
      </aside>
    </div>
  )
}
