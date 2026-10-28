import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Message, MessageStatus, ToolEvent } from '../types'
import { AssistantMarkdown } from './AssistantMarkdown'
import { GeneratingIndicator } from './GeneratingIndicator'
import { PerfPanel } from './PerfPanel'
import { VirtualLines, type LineMetrics } from './VirtualLines'

interface Props {
  messages: Message[]
  loading: boolean
  onRetry: (messageId: string) => void | Promise<void>
  onAgentStep: (
    messageId: string,
    stepIndex: number,
    action: 'approve' | 'reject' | 'retry',
  ) => void | Promise<void>
  /** 无当前会话时的空态（例如刚删光会话） */
  noSession?: boolean
  /** 简历/面试对比用；日常聊天默认关闭 */
  showPerf?: boolean
  emptyHeader?: ReactNode
}

const STATUS_LABEL: Record<MessageStatus, string> = {
  connecting: '连接中',
  generating: '生成中',
  completed: '完成',
  failed: '失败',
  cancelled: '已取消',
}

interface LiveChip {
  key: string
  text: string
  state: 'run' | 'ok' | 'fail'
  title?: string
}

/** 把流式 tool 事件压成看得懂的进度条：规划 → 执行中 → 完成。 */
function liveToolChips(events?: ToolEvent[]): LiveChip[] {
  if (!events?.length) return []
  const doneNames = new Set(
    events.filter((e) => e.phase === 'done' && e.name).map((e) => e.name as string),
  )
  const chips: LiveChip[] = []
  for (const ev of events) {
    if (ev.phase === 'idle') {
      chips.push({ key: `i${ev.seq}`, text: '本轮无需调用工具', state: 'ok' })
    } else if (ev.phase === 'running' && ev.name && !doneNames.has(ev.name)) {
      chips.push({
        key: `r${ev.seq}`,
        text: `${ev.label || ev.name} 进行中…`,
        state: 'run',
      })
    } else if (ev.phase === 'done') {
      chips.push({
        key: `d${ev.seq}`,
        text: ev.label || ev.name || '工具',
        state: ev.ok === false ? 'fail' : 'ok',
        title: ev.summary,
      })
    }
  }
  if (!chips.length) {
    const planning = events.find((e) => e.phase === 'planning')
    if (planning) {
      chips.push({
        key: `p${planning.seq}`,
        text: '正在判断需要哪些工具…',
        state: 'run',
      })
    }
  }
  return chips
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
  onAgentStep,
  noSession = false,
  showPerf = false,
  emptyHeader,
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
            <span>正在打开记录</span>
          </div>
        )}
        {!loading && !messages.length && (
          <div className="empty-stage">
            {emptyHeader ? <div className="empty-stage-top">{emptyHeader}</div> : null}
            <div className="empty-state">
              <div className="glyph">◎</div>
              {noSession ? (
                <h2>我在这，咱们开始吧</h2>
              ) : (
                <h2>继续说，我在听</h2>
              )}
            </div>
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
              {m.role === 'assistant' && (
                <header>
                  <span className="role-row">
                    <span className="avatar assistant">助</span>
                    <span className="role">助手</span>
                  </span>
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
                    {m.agent?.enabled
                      ? m.agent.calls.map((c) => (
                          <span
                            key={c.name}
                            className={`tool-chip${c.ok ? '' : ' is-failed'}`}
                            title={c.summary}
                          >
                            {c.label}
                          </span>
                        ))
                      : waiting
                        ? liveToolChips(m.toolEvents).map((c) => (
                            <span
                              key={c.key}
                              className={`tool-chip${
                                c.state === 'fail'
                                  ? ' is-failed'
                                  : c.state === 'run'
                                    ? ' is-running'
                                    : ''
                              }`}
                              title={c.title}
                            >
                              {c.text}
                            </span>
                          ))
                        : null}
                  </span>
                </header>
              )}

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

              {m.role === 'assistant' && m.agent?.enabled && m.agent.calls.length > 0 && (
                <details className="agent-plan" open={m.agent.calls.some((call) =>
                  call.status === 'waiting_confirmation' || call.status === 'failed'
                )}>
                  <summary>
                    执行计划
                    <span>{m.agent.calls.filter((call) => call.status === 'completed').length}/{m.agent.calls.length}</span>
                  </summary>
                  <ol>
                    {m.agent.calls.map((call, index) => (
                      <li key={`${call.step_index || index}-${call.name}`} data-step-status={call.status}>
                        <span className="agent-step-index">{index + 1}</span>
                        <div className="agent-step-body">
                          <strong>{call.label}</strong>
                          <span>{call.summary}</span>
                          {call.step_index && call.status === 'waiting_confirmation' && (
                            <div className="agent-step-actions">
                              <button className="btn primary small" type="button" onClick={() =>
                                void onAgentStep(m.id, call.step_index!, 'approve')
                              }>批准执行</button>
                              <button className="btn ghost small" type="button" onClick={() =>
                                void onAgentStep(m.id, call.step_index!, 'reject')
                              }>拒绝</button>
                            </div>
                          )}
                          {call.step_index && call.status === 'failed' && (
                            <div className="agent-step-actions">
                              <button className="btn ghost small" type="button" onClick={() =>
                                void onAgentStep(m.id, call.step_index!, 'retry')
                              }>重试此步骤</button>
                            </div>
                          )}
                        </div>
                        <span className="agent-step-state">
                          {call.status === 'waiting_confirmation' ? '待确认' : call.status === 'completed' ? '完成' : call.status === 'rejected' ? '已拒绝' : '失败'}
                        </span>
                      </li>
                    ))}
                  </ol>
                </details>
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
