/**
 * Line-level virtual list for long assistant content.
 * Only mounts rows in the viewport (+overscan). Reports live DOM node count.
 */
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react'

export interface LineMetrics {
  visibleNodes: number
  totalLines: number
  mode: 'virtual' | 'full'
}

interface Props {
  text: string
  virtual?: boolean
  estimateLineHeight?: number
  overscan?: number
  onMetrics?: (m: LineMetrics) => void
}

export function VirtualLines({
  text,
  virtual = true,
  estimateLineHeight = 22,
  overscan = 8,
  onMetrics,
}: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewportH, setViewportH] = useState(400)

  const lines = useMemo(() => (text ? text.split('\n') : ['']), [text])
  const totalH = lines.length * estimateLineHeight

  const range = useMemo(() => {
    if (!virtual) return { start: 0, end: lines.length }
    const start = Math.max(
      0,
      Math.floor(scrollTop / estimateLineHeight) - overscan,
    )
    const visible = Math.ceil(viewportH / estimateLineHeight)
    const end = Math.min(lines.length, start + visible + overscan * 2)
    return { start, end }
  }, [virtual, scrollTop, estimateLineHeight, overscan, viewportH, lines.length])

  const visibleLines = useMemo(
    () =>
      lines.slice(range.start, range.end).map((line, i) => ({
        index: range.start + i,
        text: line,
      })),
    [lines, range.start, range.end],
  )

  const offsetY = range.start * estimateLineHeight

  const report = useCallback(() => {
    onMetrics?.({
      visibleNodes: virtual ? visibleLines.length : lines.length,
      totalLines: lines.length,
      mode: virtual ? 'virtual' : 'full',
    })
  }, [onMetrics, virtual, visibleLines.length, lines.length])

  useEffect(() => {
    report()
  }, [report])

  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const measure = () => setViewportH(el.clientHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Stick to bottom while streaming if user hasn't scrolled up.
  useEffect(() => {
    const el = scrollerRef.current
    if (!el) return
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48
    if (nearBottom) {
      requestAnimationFrame(() => {
        el.scrollTop = el.scrollHeight
      })
    }
  }, [text.length])

  const spacerStyle: CSSProperties = virtual
    ? { height: totalH, position: 'relative', width: '100%' }
    : { position: 'relative', width: '100%' }

  const windowStyle: CSSProperties = virtual
    ? { transform: `translateY(${offsetY}px)`, willChange: 'transform' }
    : {}

  return (
    <div
      ref={scrollerRef}
      className="vline-scroller"
      onScroll={() => {
        if (!scrollerRef.current) return
        setScrollTop(scrollerRef.current.scrollTop)
        report()
      }}
    >
      <div style={spacerStyle}>
        <div style={windowStyle}>
          {visibleLines.map((row) => (
            <div
              key={row.index}
              className="vline-row"
              style={{ minHeight: estimateLineHeight }}
            >
              {row.text || ' '}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
