import { useEffect, useRef, useState } from 'react'
import type { Message, MessageStatus } from '../types'
import { AssistantMarkdown } from './AssistantMarkdown'
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
  const scrollRef = useRef<HTMLDivElement>(null)
  const bottomRef = useRef<HTMLDivElement>(null)
  const stickBottomRef = useRef(true)
  const scrollRafRef = useRef(0)
  const [useVirtual, setUseVirtual] = useState(true)
  const [metrics, setMetrics] = useState<LineMetrics | null>(null)
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [retryError, setRetryError] = useState<string | null>(null)
  const [showJumpBottom, setShowJumpBottom] = useState(false)

  const last = messages[messages.length - 1]

  const longAssistant = [...messages]
    .reverse()
    .find(
      (m) =>
        m.role === 'assistant' &&
        m.status !== 'connecting' &&
        m.status !== 'generating' &&
        m.content.split('\n').length > 20,
    )

  // 流式时不要每 chunk 都 smooth 滚到底，否则会和布局互抢导致闪动
  useEffect(() => {
    const el = scrollRef.current
    if (!el || !stickBottomRef.current) return
    if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current)
    scrollRafRef.current = requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight
    })
    return () => {
      if (scrollRafRef.current) cancelAnimationFrame(scrollRafRef.current)
    }
  }, [messages.length, last?.content.length, last?.status])

  function onScrollList() {
    const el = scrollRef.current
    if (!el) return
    const near =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80
    stickBottomRef.current = near
    setShowJumpBottom(!near && messages.length > 0)
  }

  function jumpToBottom() {
    const el = scrollRef.current
    if (!el) return
    stickBottomRef.current = true
    setShowJumpBottom(false)
    el.scrollTop = el.scrollHeight
  }

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
      <div
        className="message-scroll"
        ref={scrollRef}
        onScroll={onScrollList}
      >
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
                <h2>本模版还没有对话</h2>
                <p>
                  每个文书模版各自独立一轮对话。直接在下方发送文字或照片即可开始；左侧可切换模版查看其它板块的记录。
                </p>
              </>
            ) : (
              <>
                <h2>开始本模版分析</h2>
                <p>
                  粘贴合同或通知全文，也可上传已打码的文书照片。切换上方其它模版会打开对应独立对话，不会混在同一面板里。
                </p>
              </>
            )}
            <ol className="empty-steps">
              <li>确认上方模版与文书类型一致</li>
              <li>粘贴全文或上传已打码照片</li>
              <li>发送后看流状态；生成中可点「中断」</li>
            </ol>
            <p className="empty-disclaimer">结果仅供参考，非正式法律意见。</p>
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
          // 对比面板开启且行数多时用虚拟列表；日常完成态用 Markdown 结构化展示
          const useVirt =
            showPerf &&
            !streaming &&
            !waiting &&
            body.split('\n').length > 12 &&
            (m.status === 'completed' ||
              m.status === 'cancelled' ||
              m.status === 'failed')
          const useMarkdown =
            !streaming &&
            !waiting &&
            !useVirt &&
            m.role === 'assistant' &&
            !!body.trim()
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
                {m.role === 'assistant' && (
                  <span className="bubble-meta">
                    {!waiting && (
                      <span className={`status-chip status-${m.status}`}>
                        {STATUS_LABEL[m.status]}
                      </span>
                    )}
                    {m.rag?.enabled && (
                      <span
                        className="rag-chip is-on"
                        title={m.rag.reason || '已根据相关原文段落生成'}
                      >
                        已引用原文 {m.rag.chunks?.length ?? 0} 段
                      </span>
                    )}
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
              ) : useVirt ? (
                <VirtualLines
                  text={body}
                  virtual={useVirtual}
                  onMetrics={
                    showPerf && longAssistant?.id === m.id
                      ? setMetrics
                      : undefined
                  }
                />
              ) : useMarkdown ? (
                <AssistantMarkdown text={body} />
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
      {showJumpBottom && (
        <button
          type="button"
          className="jump-bottom"
          onClick={jumpToBottom}
          title="回到最新消息"
        >
          ↓ 回到底部
        </button>
      )}
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
