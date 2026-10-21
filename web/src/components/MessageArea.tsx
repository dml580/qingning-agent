import { useEffect, useRef, useState } from 'react'
import type { Message, MessageStatus } from '../types'
import { GeneratingIndicator } from './GeneratingIndicator'
import { PerfPanel } from './PerfPanel'
import { VirtualLines, type LineMetrics } from './VirtualLines'

interface Props {
  messages: Message[]
  loading: boolean
  onRetry: (messageId: string) => void
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

export function MessageArea({
  messages,
  loading,
  onRetry,
  showPerf = false,
}: Props) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const [useVirtual, setUseVirtual] = useState(true)
  const [metrics, setMetrics] = useState<LineMetrics | null>(null)

  const longAssistant = [...messages]
    .reverse()
    .find((m) => m.role === 'assistant' && m.content.split('\n').length > 20)

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, messages[messages.length - 1]?.content.length])

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
            <h2>开始一轮推流</h2>
            <p>
              选好上方模版后，粘贴合同或通知全文。分析会按模版提取要点与风险，
              并尽量附原文依据；结果仅供参考。
            </p>
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

              {m.status === 'failed' && (
                <div className="msg-actions">
                  <span className="err">{m.error || '生成失败'}</span>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => onRetry(m.id)}
                  >
                    重试
                  </button>
                </div>
              )}
              {m.status === 'cancelled' && (
                <div className="msg-actions">
                  <span className="muted">已中断（半截保留，状态≠成功）</span>
                  <button
                    type="button"
                    className="btn"
                    onClick={() => onRetry(m.id)}
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
