/**
 * Workbench state: modules/scenarios + sessions + stream lifecycle.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { api, type HealthInfo } from '../api/client'
import { useSseStream } from '../hooks/useSseStream'
import type {
  AppModule,
  Catalog,
  Message,
  MessageStatus,
  Scenario,
  Session,
} from '../types'

/** 文书侧栏：每个模版占一行，绑定该模版最近一次会话 */
export interface ScenarioSlot {
  scenarioId: string
  name: string
  session: Session | null
}

interface WorkbenchValue {
  catalog: Catalog | null
  modules: AppModule[]
  activeModuleId: string
  activeScenarioId: string
  activeModule: AppModule | null
  activeScenario: Scenario | null
  sessions: Session[]
  /** 文书模块：按 catalog 模版顺序的侧栏槽位；其它模块为 null */
  scenarioSlots: ScenarioSlot[] | null
  currentSessionId: string | null
  currentSession: Session | null
  messages: Message[]
  loading: boolean
  bootError: string | null
  actionError: string | null
  clearActionError: () => void
  health: HealthInfo | null
  activeAssistantId: string | null
  isStreaming: boolean
  streamStatus: MessageStatus | 'idle'
  moduleAvailable: boolean
  bootstrap: () => Promise<void>
  refreshHealth: () => Promise<void>
  setModule: (moduleId: string) => Promise<void>
  setScenario: (scenarioId: string) => Promise<void>
  selectSession: (id: string) => Promise<void>
  createSession: () => Promise<void>
  removeSession: (id: string) => Promise<void>
  send: (payload: {
    text: string
    imageBase64?: string
    imageMime?: string
  }) => Promise<void>
  cancel: () => Promise<void>
  retry: (failedMessageId: string) => Promise<void>
}

const WorkbenchContext = createContext<WorkbenchValue | null>(null)

function latestSessionForScenario(
  list: Session[],
  scenarioId: string,
): Session | null {
  let best: Session | null = null
  for (const s of list) {
    if (s.scenario_id !== scenarioId) continue
    if (!best || s.updated_at > best.updated_at) best = s
  }
  return best
}

export function WorkbenchProvider({ children }: { children: ReactNode }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [activeModuleId, setActiveModuleId] = useState('docs')
  const [activeScenarioId, setActiveScenarioId] = useState('general')
  const [sessions, setSessions] = useState<Session[]>([])
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(false)
  const [bootError, setBootError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [health, setHealth] = useState<HealthInfo | null>(null)
  const [activeAssistantId, setActiveAssistantId] = useState<string | null>(
    null,
  )

  const stream = useSseStream()
  const streamRef = useRef(stream)
  streamRef.current = stream

  const messagesRef = useRef(messages)
  messagesRef.current = messages

  const currentSessionIdRef = useRef(currentSessionId)
  currentSessionIdRef.current = currentSessionId

  const activeAssistantIdRef = useRef(activeAssistantId)
  activeAssistantIdRef.current = activeAssistantId

  const activeModuleIdRef = useRef(activeModuleId)
  activeModuleIdRef.current = activeModuleId
  const activeScenarioIdRef = useRef(activeScenarioId)
  activeScenarioIdRef.current = activeScenarioId

  const isStreaming =
    stream.status === 'connecting' || stream.status === 'generating'
  const isStreamingRef = useRef(isStreaming)
  isStreamingRef.current = isStreaming

  const modules = catalog?.modules ?? []
  const activeModule = modules.find((m) => m.id === activeModuleId) || null
  const activeScenario =
    activeModule?.scenarios.find((s) => s.id === activeScenarioId) || null
  const moduleAvailable = activeModule?.status === 'available'

  const currentSession =
    sessions.find((s) => s.id === currentSessionId) || null

  const catalogRef = useRef(catalog)
  catalogRef.current = catalog

  const scenarioSlots = useMemo<ScenarioSlot[] | null>(() => {
    if (activeModuleId !== 'docs' || !activeModule) return null
    return activeModule.scenarios
      .filter((sc) => !sc.hidden && sc.id !== 'companion')
      .map((sc) => ({
        scenarioId: sc.id,
        name: sc.name,
        session: latestSessionForScenario(sessions, sc.id),
      }))
  }, [activeModule, activeModuleId, sessions])

  const scenarioTitle = useCallback((scenarioId: string, moduleId?: string) => {
    const mid = moduleId ?? activeModuleIdRef.current
    const mod = catalogRef.current?.modules.find((m) => m.id === mid)
    return mod?.scenarios.find((s) => s.id === scenarioId)?.name || '文书分析'
  }, [])

  const upsertMessage = useCallback((msg: Message) => {
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === msg.id)
      if (idx >= 0) {
        const next = [...prev]
        next[idx] = { ...next[idx], ...msg }
        return next
      }
      return [...prev, msg]
    })
  }, [])

  const patchMessage = useCallback((id: string, patch: Partial<Message>) => {
    setMessages((prev) => {
      const idx = prev.findIndex((m) => m.id === id)
      if (idx < 0) return prev
      const next = [...prev]
      next[idx] = { ...next[idx], ...patch }
      return next
    })
  }, [])

  const refreshSessions = useCallback(async (moduleId?: string) => {
    const mid = moduleId ?? activeModuleIdRef.current
    setSessions(await api.listSessions(mid))
  }, [])

  const attachStream = useCallback(
    (sessionId: string, messageId: string, fromSeq = 0) => {
      setActiveAssistantId(messageId)
      streamRef.current.start(sessionId, messageId, fromSeq, {
        onStatus: (status) => patchMessage(messageId, { status }),
        onChunk: (seq, text) => {
          const msg = messagesRef.current.find((m) => m.id === messageId)
          if (!msg) return
          if (seq <= (msg.lastSeq ?? -1)) return
          patchMessage(messageId, {
            content: msg.content + text,
            lastSeq: seq,
            status: 'generating',
          })
        },
        onDone: (status, content) => {
          patchMessage(messageId, { status, content })
          setActiveAssistantId(null)
          void refreshSessions()
        },
        onError: (err, content) => {
          patchMessage(messageId, {
            status: 'failed',
            error: err,
            ...(content !== undefined ? { content } : {}),
          })
          setActiveAssistantId(null)
        },
      })
    },
    [patchMessage, refreshSessions],
  )

  const selectSession = useCallback(
    async (id: string) => {
      if (isStreamingRef.current) {
        streamRef.current.stop()
        setActiveAssistantId(null)
      }
      setCurrentSessionId(id)
      setLoading(true)
      try {
        const detail = await api.getSession(id)
        setActiveModuleId(detail.module_id || 'docs')
        setActiveScenarioId(detail.scenario_id || 'general')
        const mapped = detail.messages.map((m) => ({
          ...m,
          lastSeq:
            m.chunks && m.chunks.length
              ? Math.max(...m.chunks.map((c) => c.seq))
              : -1,
        }))
        setMessages(mapped)
        const unfinished = [...mapped]
          .reverse()
          .find(
            (m) =>
              m.role === 'assistant' &&
              (m.status === 'connecting' || m.status === 'generating'),
          )
        if (unfinished) {
          attachStream(id, unfinished.id, (unfinished.lastSeq ?? -1) + 1)
        }
      } finally {
        setLoading(false)
      }
    },
    [attachStream],
  )

  const openScenarioPanel = useCallback(
    async (moduleId: string, scenarioId: string, list?: Session[]) => {
      if (isStreamingRef.current) {
        streamRef.current.stop()
        setActiveAssistantId(null)
      }
      setActiveScenarioId(scenarioId)
      const sessionsList = list ?? (await api.listSessions(moduleId))
      setSessions(sessionsList)
      const match = latestSessionForScenario(sessionsList, scenarioId)
      if (match) {
        await selectSession(match.id)
      } else {
        setCurrentSessionId(null)
        setMessages([])
      }
    },
    [selectSession],
  )

  const setModule = useCallback(
    async (moduleId: string) => {
      if (moduleId === activeModuleIdRef.current) return
      if (isStreamingRef.current) {
        streamRef.current.stop()
        setActiveAssistantId(null)
      }
      setActiveModuleId(moduleId)
      const mod = catalog?.modules.find((m) => m.id === moduleId)
      const firstScen =
        mod?.scenarios.find((s) => !s.hidden && s.id !== 'companion')?.id ||
        'general'
      setActiveScenarioId(firstScen)
      setCurrentSessionId(null)
      setMessages([])
      if (mod?.status !== 'available') {
        setSessions([])
        return
      }
      if (moduleId === 'docs') {
        await openScenarioPanel(moduleId, firstScen)
        return
      }
      const list = await api.listSessions(moduleId)
      setSessions(list)
      if (list[0]) await selectSession(list[0].id)
    },
    [catalog, openScenarioPanel, selectSession],
  )

  const setScenario = useCallback(
    async (scenarioId: string) => {
      if (scenarioId === activeScenarioIdRef.current) return
      const mid = activeModuleIdRef.current
      // 文书：切换模版 = 切换到该模版自己的对话面板，不改写当前会话的 scenario
      if (mid === 'docs') {
        await openScenarioPanel(mid, scenarioId)
        return
      }
      setActiveScenarioId(scenarioId)
      const sid = currentSessionIdRef.current
      if (sid) {
        const updated = await api.patchSession(sid, mid, scenarioId)
        setSessions((prev) =>
          prev.map((s) => (s.id === sid ? { ...s, ...updated } : s)),
        )
      }
    },
    [openScenarioPanel],
  )

  const clearActionError = useCallback(() => setActionError(null), [])

  const createSession = useCallback(async () => {
    if (!moduleAvailable) return
    setActionError(null)
    const mid = activeModuleIdRef.current
    const scen = activeScenarioIdRef.current
    try {
      // 文书：一模版只保留一轮对话；「重新开始」清掉该模版旧会话再开新的
      if (mid === 'docs') {
        const ok = window.confirm(
          [
            '重新开始当前模版对话？',
            '',
            `「${scenarioTitle(scen)}」下的旧消息将从本机删除，无法恢复。`,
          ].join('\n'),
        )
        if (!ok) return
        const list = await api.listSessions(mid)
        const stale = list.filter((s) => s.scenario_id === scen)
        for (const s of stale) {
          await api.deleteSession(s.id)
        }
        const created = await api.createSession(scenarioTitle(scen), mid, scen)
        const next = await api.listSessions(mid)
        setSessions(next)
        await selectSession(created.id)
        return
      }
      const s = await api.createSession('新会话', mid, scen)
      setSessions((prev) => [s, ...prev])
      await selectSession(s.id)
    } catch (e) {
      setActionError(
        e instanceof Error
          ? e.message
          : '无法新建会话，请检查后端是否在运行。',
      )
    }
  }, [moduleAvailable, scenarioTitle, selectSession])

  const removeSession = useCallback(
    async (id: string) => {
      setActionError(null)
      try {
        const mid = activeModuleIdRef.current
        const before = await api.listSessions(mid)
        const victim = before.find((s) => s.id === id)
        await api.deleteSession(id)
        // 文书：删掉该模版下历史重复会话，保证侧栏一模版一条
        if (mid === 'docs' && victim) {
          for (const s of before) {
            if (s.id !== id && s.scenario_id === victim.scenario_id) {
              await api.deleteSession(s.id)
            }
          }
        }
        const next = await api.listSessions(mid)
        setSessions(next)
        const wasCurrent =
          currentSessionIdRef.current === id ||
          (mid === 'docs' &&
            victim &&
            currentSessionIdRef.current &&
            before.some(
              (s) =>
                s.id === currentSessionIdRef.current &&
                s.scenario_id === victim.scenario_id,
            ))
        if (wasCurrent) {
          streamRef.current.stop()
          setActiveAssistantId(null)
          if (mid === 'docs') {
            setActiveScenarioId(
              victim?.scenario_id || activeScenarioIdRef.current,
            )
            setCurrentSessionId(null)
            setMessages([])
          } else if (next[0]) {
            await selectSession(next[0].id)
          } else {
            setCurrentSessionId(null)
            setMessages([])
          }
        }
      } catch (e) {
        setActionError(
          e instanceof Error
            ? e.message
            : '删除失败，会话可能仍留在本机数据库中。',
        )
      }
    },
    [selectSession],
  )

  const send = useCallback(
    async (payload: {
      text: string
      imageBase64?: string
      imageMime?: string
    }) => {
      let sid = currentSessionIdRef.current
      const text = payload.text.trim()
      if (
        (!text && !payload.imageBase64) ||
        isStreamingRef.current ||
        !moduleAvailable
      )
        return
      setActionError(null)
      try {
        const mid = activeModuleIdRef.current
        const scen = activeScenarioIdRef.current
        // 文书：发送前强制对齐「当前模版」会话，避免仍绑着其它模版的旧 session
        if (mid === 'docs') {
          const list = await api.listSessions(mid)
          setSessions(list)
          const bound = sid
            ? list.find((s) => s.id === sid)
            : undefined
          if (!bound || bound.scenario_id !== scen) {
            const match = latestSessionForScenario(list, scen)
            if (match) {
              sid = match.id
              setCurrentSessionId(sid)
              const detail = await api.getSession(sid)
              setMessages(
                detail.messages.map((m) => ({
                  ...m,
                  lastSeq:
                    m.chunks && m.chunks.length
                      ? Math.max(...m.chunks.map((c) => c.seq))
                      : -1,
                })),
              )
            } else {
              sid = null
            }
          }
        }
        if (!sid) {
          const title =
            mid === 'docs' ? scenarioTitle(scen, mid) : '新会话'
          const s = await api.createSession(title, mid, scen)
          setSessions((prev) => [s, ...prev])
          sid = s.id
          setCurrentSessionId(sid)
          setMessages([])
        }
        // 文书默认走迷你 RAG；短文由后端自动跳过，不暴露开关给用户
        const { user_message, assistant_message, rag } = await api.sendMessage(
          sid,
          text || (payload.imageBase64 ? '请根据上传的文书照片进行分析' : ''),
          mid,
          scen,
          payload.imageBase64
            ? { base64: payload.imageBase64, mime: payload.imageMime }
            : undefined,
          mid === 'docs',
        )
        upsertMessage(user_message)
        upsertMessage({
          ...assistant_message,
          lastSeq: -1,
          ...(rag ? { rag } : {}),
        })
        attachStream(sid, assistant_message.id, 0)
        await refreshSessions()
      } catch (e) {
        const msg =
          e instanceof Error
            ? e.message
            : '发送失败，请检查网络或后端是否在运行。'
        setActionError(msg)
        throw e instanceof Error ? e : new Error(msg)
      }
    },
    [
      attachStream,
      moduleAvailable,
      refreshSessions,
      scenarioTitle,
      upsertMessage,
    ],
  )

  const cancel = useCallback(async () => {
    const sid = currentSessionIdRef.current
    const mid = activeAssistantIdRef.current
    if (!sid || !mid) return
    try {
      const res = await api.cancel(sid, mid)
      streamRef.current.stop()
      if (res.message) upsertMessage(res.message)
      else patchMessage(mid, { status: 'cancelled' })
      setActiveAssistantId(null)
    } catch (e) {
      streamRef.current.stop()
      patchMessage(mid, { status: 'cancelled' })
      setActiveAssistantId(null)
      setActionError(
        e instanceof Error
          ? e.message
          : '中断请求失败，本地已按取消处理。',
      )
    }
  }, [patchMessage, upsertMessage])

  const retry = useCallback(
    async (failedMessageId: string) => {
      const sid = currentSessionIdRef.current
      if (!sid || isStreamingRef.current) return
      setActionError(null)
      try {
        const { assistant_message, rag } = await api.retry(sid, failedMessageId, {
          moduleId: activeModuleIdRef.current,
          scenarioId: activeScenarioIdRef.current,
          useRag: activeModuleIdRef.current === 'docs',
        })
        upsertMessage({
          ...assistant_message,
          lastSeq: -1,
          ...(rag ? { rag } : {}),
        })
        attachStream(sid, assistant_message.id, 0)
      } catch (e) {
        const msg =
          e instanceof Error
            ? e.message
            : '重试失败，请检查网络或 API Key 配置。'
        setActionError(msg)
        throw e instanceof Error ? e : new Error(msg)
      }
    },
    [attachStream, upsertMessage],
  )

  const refreshHealth = useCallback(async () => {
    try {
      const h = await api.health()
      setHealth(h)
    } catch {
      /* ignore; banner/boot handles hard failures */
    }
  }, [])

  const bootstrap = useCallback(async () => {
    setLoading(true)
    setBootError(null)
    try {
      const [h, cat] = await Promise.all([api.health(), api.catalog()])
      setHealth(h)
      setCatalog(cat)
      const docs = cat.modules.find((m) => m.id === 'docs')
      const docsId = docs?.id || 'docs'
      const firstScen =
        docs?.scenarios.find((s) => !s.hidden && s.id !== 'companion')?.id ||
        'general'
      setActiveModuleId(docsId)
      setActiveScenarioId(firstScen)
      await openScenarioPanel(docsId, firstScen)
    } catch (e) {
      setBootError(
        e instanceof Error ? e.message : '无法连接后端，请先启动 server',
      )
    } finally {
      setLoading(false)
    }
  }, [openScenarioPanel])

  const value = useMemo<WorkbenchValue>(
    () => ({
      catalog,
      modules,
      activeModuleId,
      activeScenarioId,
      activeModule,
      activeScenario,
      sessions,
      scenarioSlots,
      currentSessionId,
      currentSession,
      messages,
      loading,
      bootError,
      actionError,
      clearActionError,
      health,
      activeAssistantId,
      isStreaming,
      streamStatus: stream.status,
      moduleAvailable: !!moduleAvailable,
      bootstrap,
      refreshHealth,
      setModule,
      setScenario,
      selectSession,
      createSession,
      removeSession,
      send,
      cancel,
      retry,
    }),
    [
      catalog,
      modules,
      activeModuleId,
      activeScenarioId,
      activeModule,
      activeScenario,
      sessions,
      scenarioSlots,
      currentSessionId,
      currentSession,
      messages,
      loading,
      bootError,
      actionError,
      clearActionError,
      health,
      activeAssistantId,
      isStreaming,
      stream.status,
      moduleAvailable,
      bootstrap,
      refreshHealth,
      setModule,
      setScenario,
      selectSession,
      createSession,
      removeSession,
      send,
      cancel,
      retry,
    ],
  )

  return (
    <WorkbenchContext.Provider value={value}>
      {children}
    </WorkbenchContext.Provider>
  )
}

export function useWorkbench() {
  const ctx = useContext(WorkbenchContext)
  if (!ctx) throw new Error('useWorkbench must be used within WorkbenchProvider')
  return ctx
}
