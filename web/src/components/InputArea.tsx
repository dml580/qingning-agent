import {
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react'
import { api } from '../api/client'

const PRIVACY_OPEN_KEY = 'qingning.privacyNoticeOpen'

function readPrivacyOpen(): boolean {
  try {
    const v = localStorage.getItem(PRIVACY_OPEN_KEY)
    if (v === '0') return false
    if (v === '1') return true
  } catch {
    /* ignore */
  }
  return false
}

interface Props {
  disabled: boolean
  streaming: boolean
  placeholder?: string
  seedText?: string
  seedNonce?: number
  showPrivacyNotice?: boolean
  scenarioId: string
  moduleId: string
  allowUpload?: boolean
  /** 未配置 API Key 时的演示模式 */
  demoMode?: boolean
  onSend: (payload: {
    text: string
    imageBase64?: string
    imageMime?: string
  }) => void | Promise<void>
  onCancel: () => void
}

type BannerKind = 'upload' | 'send' | 'network'

type PendingImage = {
  previewUrl: string
  base64: string
  mime: string
}

const MAX_EDGE = 1280
const JPEG_QUALITY = 0.85
const LEGACY_QUICK_TEXTS = new Set([
  '帮我看看这份合同或通知里最需要注意的点，我接下来把内容发给你。',
  '帮我记一下一个提醒：',
  '帮我查一下这件事的最新信息：',
  '帮我看看这张账单或费用单，整理出金额、时间和我接下来要做什么。',
  '我想问你一个生活上的问题：',
  '把合同、协议或通知发给我，我陪你慢慢看看重点。',
  '你想记什么提醒，慢慢告诉我就好。',
  '你想查什么信息，我来陪你一起找。',
  '把账单或费用单发给我，我帮你一起理清楚。',
  '想聊什么都可以，我在这儿听着。',
])

function isLegacyQuickDraft(text: string): boolean {
  const current = text.trim()
  if (!current) return false
  if (LEGACY_QUICK_TEXTS.has(current)) return true
  const lines = current
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return !!lines.length && lines.every((line) => LEGACY_QUICK_TEXTS.has(line))
}

async function fileToCompressedDataUrl(file: File): Promise<{
  dataUrl: string
  base64: string
  mime: string
}> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('无法处理图片')
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
  const mime = 'image/jpeg'
  const dataUrl = canvas.toDataURL(mime, JPEG_QUALITY)
  const base64 = dataUrl.split(',', 2)[1] || ''
  if (!base64) throw new Error('图片编码失败')
  return { dataUrl, base64, mime }
}

function classifySendError(message: string): BannerKind {
  const m = message.toLowerCase()
  if (
    m.includes('fetch') ||
    m.includes('network') ||
    m.includes('failed to fetch') ||
    m.includes('后端') ||
    m.includes('连接')
  ) {
    return 'network'
  }
  return 'send'
}

export function InputArea({
  disabled,
  streaming,
  placeholder,
  seedText,
  seedNonce,
  showPrivacyNotice = false,
  scenarioId,
  moduleId,
  allowUpload = true,
  demoMode = false,
  onSend,
  onCancel,
}: Props) {
  const [text, setText] = useState('')
  const [pending, setPending] = useState<PendingImage | null>(null)
  const [reviewing, setReviewing] = useState(false)
  const [privacyOpen, setPrivacyOpen] = useState(readPrivacyOpen)
  const [quickHint, setQuickHint] = useState('')
  const [hintActive, setHintActive] = useState(false)
  const [focused, setFocused] = useState(false)
  const [banner, setBanner] = useState<{
    kind: BannerKind
    text: string
  } | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const textRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (!seedText) return
    setQuickHint(seedText)
    setHintActive(true)
    setText((prev) => (isLegacyQuickDraft(prev) ? '' : prev))
    requestAnimationFrame(() => {
      textRef.current?.focus()
    })
  }, [seedNonce, seedText])

  function togglePrivacy() {
    setPrivacyOpen((prev) => {
      const next = !prev
      try {
        localStorage.setItem(PRIVACY_OPEN_KEY, next ? '1' : '0')
      } catch {
        /* ignore */
      }
      return next
    })
  }

  function clearPending() {
    setPending((prev) => {
      if (prev?.previewUrl) URL.revokeObjectURL(prev.previewUrl)
      return null
    })
  }

  async function submit(e?: { preventDefault(): void }) {
    e?.preventDefault()
    const v = text.trim()
    if (disabled || streaming || reviewing) return
    if (!v && !pending) return
    const payload = {
      text: v,
      imageBase64: pending?.base64,
      imageMime: pending?.mime,
    }
    try {
      await onSend(payload)
      setText('')
      setHintActive(false)
      clearPending()
      setBanner(null)
    } catch (err) {
      const text =
        err instanceof Error
          ? err.message
          : '发送失败，请检查网络或后端是否在运行。'
      setBanner({ kind: classifySendError(text), text })
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
  }

  async function onPickFile(file: File | null) {
    if (!file || disabled || streaming) return
    setBanner(null)
    if (!file.type.startsWith('image/')) {
      setBanner({
        kind: 'upload',
        text: '请选择图片文件（JPG / PNG / WebP）。',
      })
      return
    }
    setReviewing(true)
    try {
      const { dataUrl, base64, mime } = await fileToCompressedDataUrl(file)
      const review = await api.reviewImage({
        imageBase64: base64,
        imageMime: mime,
        moduleId,
        scenarioId,
      })
      if (!review.ok || !review.related) {
        setBanner({
          kind: 'upload',
          text:
            review.reason ||
            '这张图看起来不是相关文书照片，请上传合同/协议/通知等文书的照片或扫描件。',
        })
        clearPending()
        return
      }
      clearPending()
      setPending({
        previewUrl: dataUrl,
        base64,
        mime,
      })
      setBanner(null)
    } catch (err) {
      const text =
        err instanceof Error
          ? err.message
          : '图片审核失败，请稍后再试或改用粘贴文本。'
      setBanner({
        kind: text.toLowerCase().includes('fetch') ? 'network' : 'upload',
        text,
      })
      clearPending()
    } finally {
      setReviewing(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  function startUpload() {
    const ok = window.confirm(
      [
        '上传前请先打码隐私信息',
        '',
        '请遮挡或涂抹：身份证号、手机号、银行卡号、住址、账号密码、人脸等敏感内容。',
        '内容会发往第三方大模型分析；若因未打码导致信息泄漏，本产品不承担责任。',
        '',
        '确认已打码并继续选择图片？',
      ].join('\n'),
    )
    if (!ok) return
    fileRef.current?.click()
  }

  const canSend = (!!text.trim() || !!pending) && !disabled && !streaming && !reviewing

  return (
    <form className="input-area" onSubmit={submit}>
      {allowUpload && showPrivacyNotice && (
        <div
          className={`privacy-notice${privacyOpen ? ' is-open' : ' is-collapsed'}`}
          role="note"
        >
          <button
            type="button"
            className="privacy-notice-toggle"
            aria-expanded={privacyOpen}
            aria-controls="privacy-notice-body"
            onClick={togglePrivacy}
          >
            <span className="privacy-notice-title">隐私提醒</span>
            <span className="privacy-notice-hint">
              {privacyOpen ? '点击收起' : '点开查看脱敏与打码说明'}
            </span>
            <span className="privacy-notice-chevron" aria-hidden>
              {privacyOpen ? '▴' : '▾'}
            </span>
          </button>
          {privacyOpen && (
            <ul id="privacy-notice-body">
              <li>
                <b>粘贴文本：</b>
                发送前请自行删除或打码身份证号、手机号、银行卡号、住址、账号等关键隐私；未脱敏造成的泄漏，本产品不负责。
              </li>
              <li>
                <b>上传图片：</b>
                请先对文书照片中的隐私信息打码再上传；内容会发往第三方模型，泄漏风险自负，本产品不承担责任。
              </li>
            </ul>
          )}
        </div>
      )}

      {banner && (
        <div
          className={`upload-reject-banner kind-${banner.kind}`}
          role="alert"
        >
          <div className="upload-reject-banner-inner">
            <div className="upload-reject-title">
              {banner.kind === 'upload'
                ? '图片未通过审核，上传失败'
                : banner.kind === 'network'
                  ? '网络或后端异常'
                  : '发送失败'}
            </div>
            <p className="upload-reject-text">{banner.text}</p>
            <p className="upload-reject-tip">
              {banner.kind === 'upload'
                ? '请上传与当前模版相关的文书照片（合同、协议、通知、清单等），不要上传自拍、风景、表情包等无关图片。'
                : banner.kind === 'network'
                  ? '请确认 server 已启动（默认 :8000），并检查浏览器网络；配置好 Key 后需重启后端。'
                  : demoMode
                    ? '当前为演示模式时仍可发送，但回复为占位。若需真实分析，请配置 server/.env 中的 API Key。'
                    : '可稍后重试；若刚中断过流式输出，也可对失败消息点「重试」。'}
            </p>
          </div>
          <button
            type="button"
            className="upload-reject-close"
            onClick={() => setBanner(null)}
          >
            知道了
          </button>
        </div>
      )}

      <div className="composer">
        {pending && (
          <div className="upload-preview">
            <img src={pending.previewUrl} alt="待发送文书照片" />
            <div className="upload-preview-meta">
              <span>已通过审核 · 可随消息发送</span>
              <span className="upload-preview-warn">
                请确认图中隐私已打码；发送即表示你知悉泄漏风险自负
              </span>
              <button type="button" className="btn ghost small" onClick={clearPending}>
                移除
              </button>
            </div>
          </div>
        )}
        <div className="composer-row">
          <div
            className={`composer-box${allowUpload ? ' has-upload' : ''}${reviewing ? ' is-reviewing' : ''}`}
          >
            {allowUpload && (
              <div className="composer-toolbar">
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  className="sr-only"
                  onChange={(e) => void onPickFile(e.target.files?.[0] ?? null)}
                />
                <button
                  type="button"
                  className="composer-upload-btn"
                  disabled={disabled || reviewing || streaming}
                  onClick={startUpload}
                  title={reviewing ? '正在审核图片' : '上传已打码的文书或账单图片'}
                  aria-label={reviewing ? '正在审核图片' : '上传图片'}
                >
                  <span aria-hidden>{reviewing ? '···' : '+'}</span>
                </button>
              </div>
            )}
            <textarea
              ref={textRef}
              value={text}
              placeholder={
                quickHint && hintActive
                  ? ''
                  : streaming
                  ? '生成中…可点右侧「中断」'
                  : reviewing
                    ? '正在审核图片是否为相关文书…'
                    : placeholder ||
                      '粘贴前请先删掉隐私信息；也可上传已打码的文书照片'
              }
              disabled={disabled || reviewing || streaming}
              rows={2}
              onChange={(e) => setText(e.target.value)}
              onFocus={() => setFocused(true)}
              onBlur={() => setFocused(false)}
              onKeyDown={onKeyDown}
            />
            {!!quickHint && hintActive && !text.trim() && !focused && (
              <button
                type="button"
                className="composer-soft-hint"
                onClick={() => {
                  setFocused(true)
                  textRef.current?.focus()
                }}
              >
                {quickHint}
              </button>
            )}
          </div>
          <div className="input-actions">
            {streaming ? (
              <button type="button" className="btn danger" onClick={onCancel}>
                中断
              </button>
            ) : (
              <button type="submit" className="btn primary" disabled={!canSend}>
                发送
              </button>
            )}
          </div>
        </div>
        <div className="input-hint">
          {streaming
            ? '流式输出进行中'
            : reviewing
              ? '图片审核中，请稍候…'
              : allowUpload
                ? '粘贴文本请先脱敏；上传图片请先打码。内容可能发往第三方模型，泄漏不负责。分析仅供参考，非正式法律意见'
                : '粘贴前请删除关键隐私信息；泄漏不负责。分析仅供参考，非正式法律意见'}
        </div>
      </div>
    </form>
  )
}
