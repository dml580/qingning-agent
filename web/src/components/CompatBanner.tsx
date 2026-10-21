import { useMemo, useState } from 'react'

function detectGaps(): string[] {
  const gaps: string[] = []
  if (typeof window === 'undefined') return gaps
  if (typeof window.fetch !== 'function') {
    gaps.push('缺少 Fetch API')
  }
  if (typeof window.EventSource !== 'function') {
    gaps.push('缺少 EventSource（无法 SSE 流式）')
  }
  if (typeof CSS === 'undefined' || typeof CSS.supports !== 'function') {
    gaps.push('CSS.supports 不可用，部分样式可能异常')
  } else if (!CSS.supports('color', 'color-mix(in srgb, #000 50%, #fff)')) {
    gaps.push('不支持 color-mix，界面配色可能回退为较朴素样式')
  }
  try {
    const major = Number(
      (navigator.userAgent.match(/(?:Chrome|Chromium|Edg|Firefox|Version)\/(\d+)/) ||
        [])[1] || 0,
    )
    if (major > 0 && major < 90) {
      gaps.push(`浏览器内核版本偏旧（检测到约 ${major}），建议升级到近两年版本`)
    }
  } catch {
    /* ignore */
  }
  return gaps
}

/** 现代浏览器能力探测；缺口时给出可关闭提示（阶段 C 降级说明）。 */
export function CompatBanner() {
  const gaps = useMemo(() => detectGaps(), [])
  const [dismissed, setDismissed] = useState(false)
  if (!gaps.length || dismissed) return null

  return (
    <div className="action-banner kind-warn compat-banner" role="status">
      <div className="action-banner-body">
        <strong>浏览器兼容提示</strong>
        <p>
          青柠面向近两年的 Chrome / Edge / Firefox / Safari。当前环境：
          {gaps.join('；')}。流式对话与布局可能受影响，建议换用最新桌面浏览器。
        </p>
      </div>
      <button
        type="button"
        className="action-banner-close"
        onClick={() => setDismissed(true)}
        aria-label="关闭"
      >
        ×
      </button>
    </div>
  )
}
