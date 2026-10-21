import type { MessageStatus } from '../types'

interface Props {
  status: Extract<MessageStatus, 'connecting' | 'generating'>
}

const PHASE = {
  connecting: {
    title: '正在连接模型',
    hint: '建立 SSE，准备接收首个 token',
  },
  generating: {
    title: '正在生成回答',
    hint: '内容会逐字出现，可随时中断',
  },
} as const

/** Inline loading process — not an empty “加载中” box. */
export function GeneratingIndicator({ status }: Props) {
  const phase = PHASE[status]
  return (
    <div className="gen-indicator" role="status" aria-live="polite">
      <div className="gen-dots" aria-hidden>
        <span />
        <span />
        <span />
      </div>
      <div className="gen-copy">
        <div className="gen-title">{phase.title}</div>
        <div className="gen-hint">{phase.hint}</div>
      </div>
      <div className="gen-bar" aria-hidden>
        <i />
      </div>
    </div>
  )
}
