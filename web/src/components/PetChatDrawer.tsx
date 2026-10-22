/**
 * 桌宠双击打开的侧边迷你流式对话（独立 companion 会话，不混入文书模版历史）。
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react'
import { api } from '../api/client'
import { useSseStream } from '../hooks/useSseStream'
import type { Message } from '../types'

const SESSION_KEY = 'qingning-pet-chat-session'
const MODULE = 'docs'
const SCENARIO = 'companion'
const ASSET_VER = '21'
const MAX_EDGE = 1280
const JPEG_QUALITY = 0.85

interface Props {
  open: boolean
  onClose: () => void
}

type PendingImage = {
  previewUrl: string
  base64: string
  mime: string
}

function petAvatarSrc() {
  return `/mascot/blink/01.png?v=${ASSET_VER}`
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

export function PetChatDrawer({ open, onClose }: Props) {
  const [sessionId, setSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [text, setText] = useState('')
  const [bootError, setBootError] = useState<string | null>(null)
  const [sending, setSending] = useState(false)
  const [reviewing, setReviewing] = useState(false)
  const [pending, setPending] = useState<PendingImage | null>(null)
  const [activeAssistantId, setActiveAssistantId] = useState<string | null>(
    null,
  )
  const listRef = useRef<HTMLDivElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const stickRef = useRef(true)
  const stream = useSseStream()
  const streamRef = useRef(stream)
  streamRef.current = stream

  const isStreaming =
    stream.status === 'connecting' || stream.status === 'generating'

  function clearPending() {
    setPending((prev) => {
      if (prev?.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(prev.previewUrl)
      return null
    })
  }

  const patchMessage = useCallback((id: string, patch: Partial<Message>) => {
    setMessages((prev) => {
      const i = prev.findIndex((m) => m.id === id)
      if (i < 0) return prev
      const next = [...prev]
      next[i] = { ...next[i], ...patch }
      return next
    })
  }, [])

  const upsertMessage = useCallback((msg: Message) => {
    setMessages((prev) => {
      const i = prev.findIndex((m) => m.id === msg.id)
      if (i >= 0) {
        const next = [...prev]
        next[i] = { ...next[i], ...msg }
        return next
      }
      return [...prev, msg]
    })
  }, [])

  const attachStream = useCallback(
    (sid: string, mid: string, fromSeq = 0) => {
      setActiveAssistantId(mid)
      streamRef.current.start(sid, mid, fromSeq, {
        onStatus: (status) => patchMessage(mid, { status }),
        onChunk: (seq, chunk) => {
          setMessages((prev) => {
            const i = prev.findIndex((m) => m.id === mid)
            if (i < 0) return prev
            const msg = prev[i]
            if (seq <= (msg.lastSeq ?? -1)) return prev
            const next = [...prev]
            next[i] = {
              ...msg,
              content: msg.content + chunk,
              lastSeq: seq,
              status: 'generating',
            }
            return next
          })
        },
        onDone: (status, content) => {
          patchMessage(mid, { status, content })
          setActiveAssistantId(null)
        },
        onError: (err, content) => {
          patchMessage(mid, {
            status: 'failed',
            error: err,
            ...(content !== undefined ? { content } : {}),
          })
          setActiveAssistantId(null)
        },
      })
    },
    [patchMessage],
  )

  const ensureSession = useCallback(async () => {
    setBootError(null)
    try {
      let sid: string | null = null
      try {
        sid = localStorage.getItem(SESSION_KEY)
      } catch {
        /* ignore */
      }
      if (sid) {
        try {
          const detail = await api.getSession(sid)
          if (detail.scenario_id === SCENARIO) {
            setSessionId(detail.id)
            setMessages(
              detail.messages.map((m) => ({
                ...m,
                lastSeq:
                  m.chunks && m.chunks.length
                    ? Math.max(...m.chunks.map((c) => c.seq))
                    : -1,
              })),
            )
            const unfinished = [...detail.messages]
              .reverse()
              .find(
                (m) =>
                  m.role === 'assistant' &&
                  (m.status === 'connecting' || m.status === 'generating'),
              )
            if (unfinished) {
              attachStream(
                detail.id,
                unfinished.id,
                ((unfinished as Message).lastSeq ?? -1) + 1,
              )
            }
            return
          }
        } catch {
          /* stale id */
        }
      }
      const list = await api.listSessions(MODULE)
      const existing = list.find((s) => s.scenario_id === SCENARIO)
      if (existing) {
        const detail = await api.getSession(existing.id)
        setSessionId(existing.id)
        try {
          localStorage.setItem(SESSION_KEY, existing.id)
        } catch {
          /* ignore */
        }
        setMessages(
          detail.messages.map((m) => ({
            ...m,
            lastSeq:
              m.chunks && m.chunks.length
                ? Math.max(...m.chunks.map((c) => c.seq))
                : -1,
          })),
        )
        return
      }
      const created = await api.createSession('青柠闲聊', MODULE, SCENARIO)
      setSessionId(created.id)
      setMessages([])
      try {
        localStorage.setItem(SESSION_KEY, created.id)
      } catch {
        /* ignore */
      }
    } catch (e) {
      setBootError(
        e instanceof Error ? e.message : '无法打开闲聊，请确认后端已启动',
      )
    }
  }, [attachStream])

  useEffect(() => {
    if (!open) return
    void ensureSession()
  }, [open, ensureSession])

  useEffect(() => {
    if (!open) return
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  useEffect(() => {
    const el = listRef.current
    if (!el || !stickRef.current) return
    el.scrollTop = el.scrollHeight
  }, [messages, open])

  async function onPickFile(file: File | null) {
    if (!file || isStreaming || sending || reviewing) return
    setBootError(null)
    if (!file.type.startsWith('image/')) {
      setBootError('请选择图片文件（JPG / PNG / WebP）。')
      return
    }
    const ok = window.confirm(
      [
        '上传图片前请先打码隐私信息',
        '',
        '请遮挡身份证号、手机号、银行卡号、住址、账号等敏感内容。',
        '图片会发往模型分析；未打码导致的泄漏风险自负。',
        '',
        '确认已打码并继续？',
      ].join('\n'),
    )
    if (!ok) {
      if (fileRef.current) fileRef.current.value = ''
      return
    }
    setReviewing(true)
    try {
      const { dataUrl, base64, mime } = await fileToCompressedDataUrl(file)
      const review = await api.reviewImage({
        imageBase64: base64,
        imageMime: mime,
        moduleId: MODULE,
        scenarioId: SCENARIO,
      })
      if (!review.ok || !review.related) {
        setBootError(
          review.reason || '图片未通过审核，请换一张更清晰的照片。',
        )
        clearPending()
        return
      }
      clearPending()
      setPending({ previewUrl: dataUrl, base64, mime })
    } catch (err) {
      setBootError(
        err instanceof Error ? err.message : '图片处理失败，请稍后重试。',
      )
      clearPending()
    } finally {
      setReviewing(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  async function send(e?: FormEvent) {
    e?.preventDefault()
    const v = text.trim()
    if ((!v && !pending) || !sessionId || isStreaming || sending || reviewing)
      return
    setSending(true)
    const payloadText =
      v || (pending ? '请看看这张图，随便聊聊你注意到了什么' : '')
    const image = pending
      ? { base64: pending.base64, mime: pending.mime }
      : undefined
    setText('')
    clearPending()
    try {
      const { user_message, assistant_message } = await api.sendMessage(
        sessionId,
        payloadText,
        MODULE,
        SCENARIO,
        image,
      )
      upsertMessage(user_message)
      upsertMessage({ ...assistant_message, lastSeq: -1 })
      attachStream(sessionId, assistant_message.id, 0)
    } catch (err) {
      setBootError(
        err instanceof Error ? err.message : '发送失败，请稍后重试',
      )
    } finally {
      setSending(false)
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  async function cancel() {
    if (!sessionId || !activeAssistantId) return
    try {
      const res = await api.cancel(sessionId, activeAssistantId)
      streamRef.current.stop()
      if (res.message) upsertMessage(res.message)
      else patchMessage(activeAssistantId, { status: 'cancelled' })
    } catch {
      streamRef.current.stop()
      patchMessage(activeAssistantId, { status: 'cancelled' })
    }
    setActiveAssistantId(null)
  }

  if (!open) return null

  return (
    <div className="pet-chat-root" role="dialog" aria-label="青柠闲聊">
      <button
        type="button"
        className="pet-chat-backdrop"
        aria-label="关闭闲聊"
        onClick={onClose}
      />
      <aside className="pet-chat-drawer">
        <header className="pet-chat-head">
          <img
            src={petAvatarSrc()}
            alt=""
            className="pet-chat-avatar"
            draggable={false}
          />
          <div className="pet-chat-head-copy">
            <strong>青柠</strong>
            <span>在这里随便聊聊生活小事～</span>
          </div>
          <button
            type="button"
            className="pet-chat-close"
            onClick={onClose}
            aria-label="关闭"
          >
            ×
          </button>
        </header>

        {bootError && (
          <div className="pet-chat-banner" role="alert">
            {bootError}
            <button type="button" className="link" onClick={() => setBootError(null)}>
              关闭
            </button>
          </div>
        )}

        <div
          className="pet-chat-list"
          ref={listRef}
          onScroll={() => {
            const el = listRef.current
            if (!el) return
            stickRef.current =
              el.scrollHeight - el.scrollTop - el.clientHeight < 48
          }}
        >
          {!messages.length && (
            <div className="pet-chat-empty">
              <p>双击桌宠就找到我啦。</p>
              <p className="muted">正式合同分析请用中间工作台的文书模版。</p>
            </div>
          )}
          {messages.map((m) => (
            <div
              key={m.id}
              className={`pet-chat-bubble ${m.role}`}
              data-status={m.status}
            >
              {m.role === 'assistant' && (
                <div className="pet-chat-role">青柠的想法</div>
              )}
              <div className="pet-chat-text">
                {m.content ||
                  (m.status === 'connecting' || m.status === 'generating'
                    ? '…'
                    : '')}
                {(m.status === 'generating' || m.status === 'connecting') &&
                  !!m.content && <span className="pet-chat-cursor" />}
              </div>
              {m.status === 'failed' && (
                <div className="pet-chat-err">{m.error || '发送失败'}</div>
              )}
            </div>
          ))}
        </div>

        <form className="pet-chat-composer" onSubmit={(e) => void send(e)}>
          {pending && (
            <div className="pet-chat-preview">
              <img src={pending.previewUrl} alt="待发送图片" />
              <button
                type="button"
                className="btn ghost small"
                onClick={clearPending}
                disabled={isStreaming || sending}
              >
                移除
              </button>
            </div>
          )}
          <div
            className={`pet-chat-box${reviewing ? ' is-reviewing' : ''}`}
          >
            <input
              ref={fileRef}
              type="file"
              accept="image/jpeg,image/png,image/webp,image/gif"
              className="sr-only"
              onChange={(e) => void onPickFile(e.target.files?.[0] ?? null)}
            />
            <button
              type="button"
              className="pet-chat-upload"
              disabled={
                isStreaming || sending || reviewing || !sessionId
              }
              title="上传图片"
              aria-label="上传图片"
              onClick={() => fileRef.current?.click()}
            >
              <span className="pet-chat-upload-icon" aria-hidden>
                +
              </span>
              <span className="pet-chat-upload-tip">上传图片</span>
            </button>
            <textarea
              value={text}
              rows={2}
              placeholder={
                reviewing
                  ? '正在审核图片…'
                  : isStreaming
                    ? '生成中…可点「中断」'
                    : '想聊点什么？青柠在听哦～'
              }
              disabled={isStreaming || sending || reviewing || !sessionId}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={onKeyDown}
            />
          </div>
          <div className="pet-chat-actions">
            {isStreaming ? (
              <button type="button" className="btn danger small" onClick={() => void cancel()}>
                中断
              </button>
            ) : (
              <button
                type="submit"
                className="btn primary small"
                disabled={
                  (!text.trim() && !pending) ||
                  !sessionId ||
                  sending ||
                  reviewing
                }
              >
                发送
              </button>
            )}
          </div>
        </form>
      </aside>
    </div>
  )
}
