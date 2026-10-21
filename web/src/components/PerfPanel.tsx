import { useEffect, useRef, useState } from 'react'
import type { LineMetrics } from './VirtualLines'

interface Props {
  metrics: LineMetrics | null
  useVirtual: boolean
  onToggleVirtual: (v: boolean) => void
}

/**
 * Live node-count + approx scroll FPS while the message scroller moves.
 * Used for the resume/interview comparison artifact.
 */
export function PerfPanel({ metrics, useVirtual, onToggleVirtual }: Props) {
  const [fps, setFps] = useState<number | null>(null)
  const frames = useRef(0)
  const last = useRef(performance.now())
  const raf = useRef(0)

  useEffect(() => {
    const tick = (t: number) => {
      frames.current += 1
      if (t - last.current >= 1000) {
        setFps(frames.current)
        frames.current = 0
        last.current = t
      }
      raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [])

  return (
    <div className="perf-panel">
      <div className="perf-title">虚拟列表对比</div>
      <label className="perf-toggle">
        <input
          type="checkbox"
          checked={useVirtual}
          onChange={(e) => onToggleVirtual(e.target.checked)}
        />
        启用虚拟列表
      </label>
      <dl>
        <div>
          <dt>模式</dt>
          <dd>{metrics?.mode ?? '—'}</dd>
        </div>
        <div>
          <dt>总行数</dt>
          <dd>{metrics?.totalLines ?? '—'}</dd>
        </div>
        <div>
          <dt>挂载节点</dt>
          <dd className={useVirtual ? 'good' : 'warn'}>
            {metrics?.visibleNodes ?? '—'}
          </dd>
        </div>
        <div>
          <dt>页面 FPS</dt>
          <dd>{fps ?? '—'}</dd>
        </div>
      </dl>
      <p className="perf-hint">
        关掉虚拟列表再滚动长回复：挂载节点≈总行数，布局更重；打开后只保留视口附近几十行。
        面试可讲：同一条消息不重复挂载，流式只改 content，行级虚拟化控 DOM。
      </p>
    </div>
  )
}
