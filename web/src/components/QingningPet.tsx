import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from 'react'

type Phase = 'idle' | 'blink' | 'sway'

/** 静止用眨眼第 1 帧（站立原图）；眨眼 / 晃动慢播 */
const ANIM = {
  blink: { count: 8, fps: 3.2 },
  sway: { count: 8, fps: 3.2 },
} as const

/** 展开后：静止 30s → 眨眼 30s → 静止 30s → 晃动 30s → 循环 */
const CYCLE: { phase: Phase; ms: number }[] = [
  { phase: 'idle', ms: 30_000 },
  { phase: 'blink', ms: 30_000 },
  { phase: 'idle', ms: 30_000 },
  { phase: 'sway', ms: 30_000 },
]

/** 无点击则收回侧边 */
const DOCK_IDLE_MS = 2 * 60 * 1000

/** 抠图更新后改版本号，避免浏览器缓存旧帧 */
const ASSET_VER = '21'

const SIZE = 112
/** 贴边锚点：约半个身子在屏内，再靠 CSS 斜向探出「偷窥」感 */
const DOCK_VISIBLE = 58
const STORAGE_EXPANDED_Y = 'qingning-pet-expanded-y'

function frameSrc(kind: 'blink' | 'sway', index: number) {
  const n = String(index + 1).padStart(2, '0')
  return `/mascot/${kind}/${n}.png?v=${ASSET_VER}`
}

function preload() {
  ;(['blink', 'sway'] as const).forEach((name) => {
    for (let i = 0; i < ANIM[name].count; i += 1) {
      const img = new Image()
      img.src = frameSrc(name, i)
    }
  })
}

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v))
}

function dockPos(preferY?: number) {
  const w = typeof window !== 'undefined' ? window.innerWidth : 1200
  const h = typeof window !== 'undefined' ? window.innerHeight : 800
  const fallbackY = h * 0.58 - SIZE / 2
  return {
    x: Math.max(8, w - DOCK_VISIBLE),
    y: clamp(
      typeof preferY === 'number' && !Number.isNaN(preferY) ? preferY : fallbackY,
      96,
      h - SIZE - 48,
    ),
  }
}

/** 拖到右侧边缘附近则视为主动贴边 */
function isNearRightEdge(x: number) {
  const w = typeof window !== 'undefined' ? window.innerWidth : 1200
  return x >= w - SIZE - 56
}

function expandedPos(y?: number) {
  const w = typeof window !== 'undefined' ? window.innerWidth : 1200
  const h = typeof window !== 'undefined' ? window.innerHeight : 800
  let ey = y
  if (ey == null) {
    try {
      const raw = localStorage.getItem(STORAGE_EXPANDED_Y)
      if (raw) ey = Number(raw)
    } catch {
      /* ignore */
    }
  }
  return {
    x: Math.max(8, w - SIZE - 28),
    y: clamp(
      typeof ey === 'number' && !Number.isNaN(ey) ? ey : h * 0.55 - SIZE / 2,
      8,
      h - SIZE - 8,
    ),
  }
}

interface Props {
  /** 双击打开侧边闲聊 */
  onOpenChat?: () => void
}

/**
 * 桌宠青柠：默认贴右侧；单击展开动画；双击打开侧边闲聊；拖回或两分钟无操作贴边。
 */
export function QingningPet({ onOpenChat }: Props) {
  const [docked, setDocked] = useState(true)
  const [pos, setPos] = useState(() =>
    typeof window !== 'undefined' ? dockPos() : { x: 24, y: 24 },
  )
  const [phase, setPhase] = useState<Phase>('idle')
  const [frame, setFrame] = useState(0)
  const [hidden, setHidden] = useState(false)
  const [dragging, setDragging] = useState(false)

  const dockedRef = useRef(true)
  const phaseRef = useRef<Phase>('idle')
  const cycleIdxRef = useRef(0)
  const draggingRef = useRef(false)
  const movedRef = useRef(false)
  const originRef = useRef({ x: 0, y: 0, px: 0, py: 0 })
  const resumeIdxRef = useRef(0)
  const dockTimerRef = useRef(0)
  const cycleTimerRef = useRef(0)

  const enterPhase = useCallback((idx: number) => {
    if (dockedRef.current) return
    const next = CYCLE[idx % CYCLE.length]
    cycleIdxRef.current = idx % CYCLE.length
    phaseRef.current = next.phase
    setPhase(next.phase)
    setFrame(0)
  }, [])

  const stopCycle = useCallback(() => {
    if (cycleTimerRef.current) {
      window.clearTimeout(cycleTimerRef.current)
      cycleTimerRef.current = 0
    }
    cycleIdxRef.current = 0
    phaseRef.current = 'idle'
    setPhase('idle')
    setFrame(0)
  }, [])

  const startCycle = useCallback(() => {
    if (cycleTimerRef.current) {
      window.clearTimeout(cycleTimerRef.current)
      cycleTimerRef.current = 0
    }
    enterPhase(0)

    const arm = (ms: number) => {
      cycleTimerRef.current = window.setTimeout(() => {
        if (dockedRef.current) return
        if (draggingRef.current) {
          arm(400)
          return
        }
        enterPhase(cycleIdxRef.current + 1)
        arm(CYCLE[cycleIdxRef.current].ms)
      }, ms)
    }
    arm(CYCLE[0].ms)
  }, [enterPhase])

  const goDock = useCallback(
    (preferY?: number) => {
      dockedRef.current = true
      setDocked(true)
      stopCycle()
      setPos(dockPos(preferY))
      if (dockTimerRef.current) {
        window.clearTimeout(dockTimerRef.current)
        dockTimerRef.current = 0
      }
    },
    [stopCycle],
  )

  const goExpand = useCallback(
    (fromY?: number) => {
      dockedRef.current = false
      setDocked(false)
      const next = expandedPos(fromY)
      setPos(next)
      try {
        localStorage.setItem(STORAGE_EXPANDED_Y, String(next.y))
      } catch {
        /* ignore */
      }
      startCycle()
    },
    [startCycle],
  )

  /** 任意与宠物的交互都重新计 2 分钟收回 */
  const bumpIdle = useCallback(() => {
    if (dockedRef.current) return
    if (dockTimerRef.current) window.clearTimeout(dockTimerRef.current)
    dockTimerRef.current = window.setTimeout(() => {
      goDock()
    }, DOCK_IDLE_MS)
  }, [goDock])

  useEffect(() => {
    preload()
    setPos(dockPos())
    return () => {
      if (dockTimerRef.current) window.clearTimeout(dockTimerRef.current)
      if (cycleTimerRef.current) window.clearTimeout(cycleTimerRef.current)
    }
  }, [])

  useEffect(() => {
    if (phase === 'idle' || docked) {
      setFrame(0)
      return
    }
    const cfg = ANIM[phase]
    const interval = 1000 / cfg.fps
    const id = window.setInterval(() => {
      setFrame((f) => (f + 1) % cfg.count)
    }, interval)
    return () => clearInterval(id)
  }, [phase, docked])

  useEffect(() => {
    const onResize = () => {
      if (dockedRef.current) {
        setPos(dockPos())
        return
      }
      setPos((p) => ({
        x: clamp(p.x, 8, window.innerWidth - SIZE - 8),
        y: clamp(p.y, 8, window.innerHeight - SIZE - 8),
      }))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const openChatFromPet = () => {
    if (!dockedRef.current) bumpIdle()
    else {
      goExpand(pos.y)
      bumpIdle()
    }
    onOpenChat?.()
  }

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return

    // 贴边：单击展开，不进入拖拽（双击另开会打开闲聊）
    if (dockedRef.current) {
      e.preventDefault()
      goExpand(pos.y)
      bumpIdle()
      return
    }

    e.currentTarget.setPointerCapture(e.pointerId)
    draggingRef.current = true
    setDragging(true)
    movedRef.current = false
    originRef.current = {
      x: e.clientX,
      y: e.clientY,
      px: pos.x,
      py: pos.y,
    }
    resumeIdxRef.current = cycleIdxRef.current
    phaseRef.current = 'sway'
    setPhase('sway')
    setFrame(0)
    bumpIdle()
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current || dockedRef.current) return
    const dx = e.clientX - originRef.current.x
    const dy = e.clientY - originRef.current.y
    if (Math.abs(dx) + Math.abs(dy) > 4) movedRef.current = true
    setPos({
      x: clamp(originRef.current.px + dx, 8, window.innerWidth - SIZE - 8),
      y: clamp(originRef.current.py + dy, 8, window.innerHeight - SIZE - 8),
    })
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (dockedRef.current) return
    if (!draggingRef.current) return
    draggingRef.current = false
    setDragging(false)
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    // 用户主动拖到右侧 → 贴边待机（与两分钟自动收回相同）
    if (movedRef.current && isNearRightEdge(pos.x)) {
      goDock(pos.y)
      return
    }
    try {
      localStorage.setItem(STORAGE_EXPANDED_Y, String(pos.y))
    } catch {
      /* ignore */
    }
    bumpIdle()
    if (!movedRef.current) {
      phaseRef.current = 'blink'
      setPhase('blink')
      setFrame(0)
    } else {
      enterPhase(resumeIdxRef.current)
    }
  }

  const imgSrc =
    phase === 'idle' || docked
      ? frameSrc('blink', 0)
      : frameSrc(phase, frame)

  if (hidden) {
    return (
      <button
        type="button"
        className="qn-pet-show"
        onClick={() => {
          setHidden(false)
          goDock()
        }}
        title="召唤青柠"
      >
        青柠
      </button>
    )
  }

  return (
    <div
      className={`qn-pet${docked ? ' is-docked' : ' is-expanded'}${dragging ? ' is-dragging' : ''}`}
      style={{ left: pos.x, top: pos.y, width: SIZE, height: SIZE }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDoubleClick={(e) => {
        e.preventDefault()
        e.stopPropagation()
        if (movedRef.current) return
        openChatFromPet()
      }}
      onDragStart={(e) => e.preventDefault()}
      role="img"
      aria-label={
        docked
          ? '青柠桌宠，单击展开，双击打开闲聊'
          : '青柠桌宠，可拖拽；双击打开闲聊；拖到右侧或两分钟无操作会贴边'
      }
      title="单击展开 · 双击闲聊"
    >
      <img
        src={imgSrc}
        alt=""
        draggable={false}
        className="qn-pet-img"
        onDragStart={(e) => e.preventDefault()}
      />
      {!docked && (
        <button
          type="button"
          className="qn-pet-hide"
          onClick={(e) => {
            e.stopPropagation()
            setHidden(true)
            stopCycle()
            if (dockTimerRef.current) {
              window.clearTimeout(dockTimerRef.current)
              dockTimerRef.current = 0
            }
          }}
          title="先藏起来"
          aria-label="隐藏青柠"
        >
          ×
        </button>
      )}
    </div>
  )
}
