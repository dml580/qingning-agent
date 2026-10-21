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

/** 静止 30s → 眨眼 30s → 静止 30s → 晃动 30s → 循环 */
const CYCLE: { phase: Phase; ms: number }[] = [
  { phase: 'idle', ms: 30_000 },
  { phase: 'blink', ms: 30_000 },
  { phase: 'idle', ms: 30_000 },
  { phase: 'sway', ms: 30_000 },
]

/** 抠图更新后改版本号，避免浏览器缓存旧帧 */
const ASSET_VER = '20'

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

const STORAGE_KEY = 'qingning-pet-pos'
const SIZE = 112

function loadPos(): { x: number; y: number } {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw) {
      const p = JSON.parse(raw) as { x: number; y: number }
      if (typeof p.x === 'number' && typeof p.y === 'number') return p
    }
  } catch {
    /* ignore */
  }
  return {
    x: Math.max(16, window.innerWidth - SIZE - 28),
    y: Math.max(16, window.innerHeight - SIZE - 28),
  }
}

function clamp(v: number, min: number, max: number) {
  return Math.min(max, Math.max(min, v))
}

/**
 * 桌宠青柠：静止→眨眼→静止→晃动，各 30s 循环；可拖拽。
 */
export function QingningPet() {
  const [pos, setPos] = useState(() =>
    typeof window !== 'undefined' ? loadPos() : { x: 24, y: 24 },
  )
  const [phase, setPhase] = useState<Phase>('idle')
  const [frame, setFrame] = useState(0)
  const [hidden, setHidden] = useState(false)

  const phaseRef = useRef<Phase>('idle')
  const cycleIdxRef = useRef(0)
  const draggingRef = useRef(false)
  const movedRef = useRef(false)
  const originRef = useRef({ x: 0, y: 0, px: 0, py: 0 })
  const resumeIdxRef = useRef(0)

  const enterPhase = useCallback((idx: number) => {
    const next = CYCLE[idx % CYCLE.length]
    cycleIdxRef.current = idx % CYCLE.length
    phaseRef.current = next.phase
    setPhase(next.phase)
    setFrame(0)
  }, [])

  useEffect(() => {
    preload()
  }, [])

  // 按周期推进阶段（拖拽中暂缓切换）
  useEffect(() => {
    let timer = 0

    const arm = (ms: number) => {
      timer = window.setTimeout(() => {
        if (draggingRef.current) {
          arm(400)
          return
        }
        enterPhase(cycleIdxRef.current + 1)
        arm(CYCLE[cycleIdxRef.current].ms)
      }, ms)
    }

    arm(CYCLE[0].ms)
    return () => clearTimeout(timer)
  }, [enterPhase])

  // 眨眼 / 晃动阶段播帧；静止钉在第 1 帧
  useEffect(() => {
    if (phase === 'idle') {
      setFrame(0)
      return
    }
    const cfg = ANIM[phase]
    const interval = 1000 / cfg.fps
    const id = window.setInterval(() => {
      setFrame((f) => (f + 1) % cfg.count)
    }, interval)
    return () => clearInterval(id)
  }, [phase])

  useEffect(() => {
    const onResize = () => {
      setPos((p) => ({
        x: clamp(p.x, 8, window.innerWidth - SIZE - 8),
        y: clamp(p.y, 8, window.innerHeight - SIZE - 8),
      }))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    draggingRef.current = true
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
  }

  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return
    const dx = e.clientX - originRef.current.x
    const dy = e.clientY - originRef.current.y
    if (Math.abs(dx) + Math.abs(dy) > 4) movedRef.current = true
    setPos({
      x: clamp(originRef.current.px + dx, 8, window.innerWidth - SIZE - 8),
      y: clamp(originRef.current.py + dy, 8, window.innerHeight - SIZE - 8),
    })
  }

  const onPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return
    draggingRef.current = false
    try {
      e.currentTarget.releasePointerCapture(e.pointerId)
    } catch {
      /* ignore */
    }
    setPos((p) => {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(p))
      return p
    })
    // 轻点：播一下眨眼；拖完：回到当前周期阶段
    if (!movedRef.current) {
      phaseRef.current = 'blink'
      setPhase('blink')
      setFrame(0)
    } else {
      enterPhase(resumeIdxRef.current)
    }
  }

  const imgSrc =
    phase === 'idle'
      ? frameSrc('blink', 0)
      : frameSrc(phase, frame)

  if (hidden) {
    return (
      <button
        type="button"
        className="qn-pet-show"
        onClick={() => setHidden(false)}
        title="召唤青柠"
      >
        青柠
      </button>
    )
  }

  return (
    <div
      className="qn-pet"
      style={{ left: pos.x, top: pos.y, width: SIZE, height: SIZE }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      role="img"
      aria-label="青柠桌宠，可拖拽"
      title="拖我走走 · 静止/眨眼/晃动各约 30 秒循环"
    >
      <img src={imgSrc} alt="" draggable={false} className="qn-pet-img" />
      <button
        type="button"
        className="qn-pet-hide"
        onClick={(e) => {
          e.stopPropagation()
          setHidden(true)
        }}
        title="先藏起来"
        aria-label="隐藏青柠"
      >
        ×
      </button>
    </div>
  )
}
