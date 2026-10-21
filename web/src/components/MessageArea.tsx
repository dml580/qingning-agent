import { useEffect, useRef, useState } from 'react'
import type { Message, MessageStatus } from '../types'
import { GeneratingIndicator } from './GeneratingIndicator'
import { PerfPanel } from './PerfPanel'
import { VirtualLines, type LineMetrics } from './VirtualLines'

interface Props {
  messages: Message[]
  loading: boolean
  onRetry: (messageId: string) => void | Promise<void>
  /** 无当前会话时的空态（例如刚删光会话） */
  noSession?: boolean
  /** 简历/面试对比用；日常聊天默认关闭 */
  showPerf?: boolean
}

const STATUS_LABEL: Record<MessageStatus, string> = {
  connecting: '连接中',
  generating: '生成中',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消',
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.left = '-9999px'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(ta)
      return ok
    } catch {
      return false
    }
  }
}

function downloadMarkdown(filename: string, text: string) {
  const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.click()
  URL.revokeObjectURL(url)
}

export function MessageArea({
  messages,
  loading,
  onRetry,
  noSession = false,
  showPerf = false,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const [useVirtual, setUseVirtual] = useState(true)
  const [metrics, setMetrics] = useState<LineMetrics | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [retryError, setRetryError] = useState<string | null>(null)

  const longAssistant = [...messages]
    .reverse()
    .find((m) => m.role === 'assistant' && m.content.split('\n').length > 20)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, messages[messages.length - 1]?.content.length])

  async function handleRetry(id: string) {
    setRetryError(null)
    try {
      await onRetry(id)
    } catch (e) {
      setRetryError(
        e instanceof Error
          ? e.message
          : '重试失败，请检查网络或后端是否仍在运行。',
      )
    }
  }

  async function handleCopy(id: string, text: string) {
    const ok = await copyText(text)
    if (ok) {
      setCopiedId(id)
      window.setTimeout(() => setCopiedId((cur) => (cur === id ? null : cur)), 1600)
    }
  }

  return (
    <div className={`message-area ${showPerf ? 'with-perf' : ''}`}>
      <div className="message-scroll">
        {loading && (
          <div className="page-loading" role="status">
            <div className="gen-dots" aria-hidden>
              <span />
              <span />
              <span />
            </div>
            <span>正在拉取会话</span>
          </div>
        )}
        {!loading && !messages.length && (
          <div className="empty-state">
            <div className="glyph">◎</div>
            {noSession ? (
              <>
                <h2>还没有会话</h2>
                <p>
                  点左侧「新建会话」，或直接在下方输入框发送——会自动创建会话并开始分析。
                </p>
              </>
            ) : (
              <>
                <h2>开始一轮推流</h2>
                <p>
                  选好上方模版后，粘贴合同或通知全文，也可上传已打码的文书照片。
                  分析会按模版提取要点与风险；结果仅供参考，非正式法律意见。
                </p>
              </>
            )}
          </div>
        )}
        {retryError && (
          <div className="inline-error" role="alert">
            <span>{retryError}</span>
            <button
              type="button"
              className="link"
              onClick={() => setRetryError(null)}
            >
              关闭
            </button>
          </div>
        )}
        {messages.map((m) => {
          const waiting =
            m.role === 'assistant' &&
            (m.status === 'connecting' || m.status === 'generating') &&
            !m.content.trim()
          const streaming =
            m.role === 'assistant' &&
            (m.status === 'connecting' || m.status === 'generating') &&
            !!m.content.trim()
          const body = m.content || ''
          const long = body.split('\n').length > 12
          const canExport =
            m.role === 'assistant' &&
            !!body.trim() &&
            (m.status === 'completed' ||
              m.status === 'cancelled' ||
              m.status === 'failed')

          return (
            <article
              key={m.id}
              className={`bubble ${m.role}${waiting ? ' waiting' : ''}`}
              data-status={m.status}
            >
              <header>
                <span className="role-row">
                  <span className={`avatar ${m.role}`}>
                    {m.role === 'user' ? '你' : '助'}
                  </span>
                  <span className="role">
                    {m.role === 'user' ? '你' : '助手'}
                  </span>
                </span>
                {m.role === 'assistant' && !waiting && (
                  <span className={`status-chip status-${m.status}`}>
                    {STATUS_LABEL[m.status]}
                  </span>
                )}
              </header>

              {m.role === 'user' ? (
                <pre className="plain">{m.content}</pre>
              ) : waiting ? (
                <GeneratingIndicator
                  status={
                    m.status === 'connecting' ? 'connecting' : 'generating'
                  }
                />
              ) : long ? (
                <VirtualLines
                  text={body}
                  virtual={useVirtual}
                  onMetrics={
                    showPerf && longAssistant?.id === m.id
                      ? setMetrics
                      : undefined
                  }
                />
              ) : (
                <pre className={`plain ${streaming ? 'typing-cursor' : ''}`}>
                  {body}
                </pre>
              )}

              {canExport && (
                <div className="msg-actions export">
                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={() => void handleCopy(m.id, body)}
                  >
                    {copiedId === m.id ? '已复制' : '复制全文'}
                  </button>
                  <button
                    type="button"
                    className="btn ghost small"
                    onClick={() =>
                      downloadMarkdown(
                        `qingning-${m.id.slice(0, 8)}.md`,
                        body,
                      )
                    }
                  >
                    导出 Markdown
                  </button>
                </div>
              )}

              {m.status === 'failed' && (
                <div className="msg-actions">
                  <span className="err">
                    {m.error || '生成失败。请检查网络、API Key，或稍后重试。'}
                  </span>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void handleRetry(m.id)}
                  >
                    重试
                  </button>
                </div>
              )}
              {m.status === 'cancelled' && (
                <div className="msg-actions">
                  <span className="muted">
                    已中断（半截内容已保留，状态不算成功）
                  </span>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => void handleRetry(m.id)}
                  >
                    重试
                  </button>
                </div>
              )}
            </article>
          )
        })}
        <div ref={bottomRef} />
      </div>
      {showPerf && (
        <PerfPanel
          metrics={metrics}
          useVirtual={useVirtual}
          onToggleVirtual={setUseVirtual}
        />
      )}
    </div>
  )
}
