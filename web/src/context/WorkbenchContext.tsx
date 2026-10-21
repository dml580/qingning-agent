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

interface WorkbenchValue {
  catalog: Catalog | null
  modules: AppModule[]
  activeModuleId: string
  activeScenarioId: string
  activeModule: AppModule | null
  activeScenario: Scenario | null
  sessions: Session[]
  currentSessionId: string | null
  currentSession: Session | null
  messages: Message[]
  loading: boolean
  bootError: string | null
  health: HealthInfo | null
  activeAssistantId: string | null
  isStreaming: boolean
  streamStatus: MessageStatus | 'idle'
  moduleAvailable: boolean
  bootstrap: () => Promise<void>
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

export function WorkbenchProvider({ children }: { children: ReactNode }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [activeModuleId, setActiveModuleId] = useState('docs')
  const [activeScenarioId, setActiveScenarioId] = useState('general')
  const [sessions, setSessions] = useState<Session[]>([])
  const [currentSessionId, setCurrentSessionId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Message[]>([])
  const [loading, setLoading] = useState(false)
  const [bootError, setBootError] = useState<string | null>(null)
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

  const setModule = useCallback(
    async (moduleId: string) => {
      if (moduleId === activeModuleIdRef.current) return
      if (isStreamingRef.current) {
        streamRef.current.stop()
        setActiveAssistantId(null)
      }
      setActiveModuleId(moduleId)
      const mod = catalog?.modules.find((m) => m.id === moduleId)
      const firstScen = mod?.scenarios[0]?.id || 'general'
      setActiveScenarioId(firstScen)
      setCurrentSessionId(null)
      setMessages([])
      if (mod?.status !== 'available') {
        setSessions([])
        return
      }
      const list = await api.listSessions(moduleId)
      setSessions(list)
      if (list[0]) await selectSession(list[0].id)
    },
    [catalog, selectSession],
  )

  const setScenario = useCallback(
    async (scenarioId: string) => {
      if (scenarioId === activeScenarioIdRef.current) return
      setActiveScenarioId(scenarioId)
      const sid = currentSessionIdRef.current
      const mid = activeModuleIdRef.current
      if (sid) {
        const updated = await api.patchSession(sid, mid, scenarioId)
        setSessions((prev) =>
          prev.map((s) => (s.id === sid ? { ...s, ...updated } : s)),
        )
      }
    },
    [],
  )

  const createSession = useCallback(async () => {
    if (!moduleAvailable) return
    const s = await api.createSession(
      '新会话',
      activeModuleIdRef.current,
      activeScenarioIdRef.current,
    )
    setSessions((prev) => [s, ...prev])
    await selectSession(s.id)
  }, [moduleAvailable, selectSession])

  const removeSession = useCallback(
    async (id: string) => {
      await api.deleteSession(id)
      setSessions((prev) => {
        const next = prev.filter((s) => s.id !== id)
        if (currentSessionIdRef.current === id) {
          streamRef.current.stop()
          setActiveAssistantId(null)
          setCurrentSessionId(null)
          setMessages([])
          if (next[0]) void selectSession(next[0].id)
        }
        return next
      })
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
      if (!sid) {
        const s = await api.createSession(
          '新会话',
          activeModuleIdRef.current,
          activeScenarioIdRef.current,
        )
        setSessions((prev) => [s, ...prev])
        sid = s.id
        setCurrentSessionId(sid)
        setMessages([])
      }
      const { user_message, assistant_message } = await api.sendMessage(
        sid,
        text || (payload.imageBase64 ? '请根据上传的文书照片进行分析' : ''),
        activeModuleIdRef.current,
        activeScenarioIdRef.current,
        payload.imageBase64
          ? { base64: payload.imageBase64, mime: payload.imageMime }
          : undefined,
      )
      upsertMessage(user_message)
      upsertMessage({ ...assistant_message, lastSeq: -1 })
      attachStream(sid, assistant_message.id, 0)
      await refreshSessions()
    },
    [attachStream, moduleAvailable, refreshSessions, upsertMessage],
  )

  const cancel = useCallback(async () => {
    const sid = currentSessionIdRef.current
    const mid = activeAssistantIdRef.current
    if (!sid || !mid) return
    const res = await api.cancel(sid, mid)
    streamRef.current.stop()
    if (res.message) upsertMessage(res.message)
    else patchMessage(mid, { status: 'cancelled' })
    setActiveAssistantId(null)
  }, [patchMessage, upsertMessage])

  const retry = useCallback(
    async (failedMessageId: string) => {
      const sid = currentSessionIdRef.current
      if (!sid || isStreamingRef.current) return
      const { assistant_message } = await api.retry(sid, failedMessageId, {
        moduleId: activeModuleIdRef.current,
        scenarioId: activeScenarioIdRef.current,
      })
      upsertMessage({ ...assistant_message, lastSeq: -1 })
      attachStream(sid, assistant_message.id, 0)
    },
    [attachStream, upsertMessage],
  )

  const bootstrap = useCallback(async () => {
    setLoading(true)
    setBootError(null)
    try {
      const [h, cat] = await Promise.all([api.health(), api.catalog()])
      setHealth(h)
      setCatalog(cat)
      const docs = cat.modules.find((m) => m.id === 'docs')
      setActiveModuleId(docs?.id || 'docs')
      setActiveScenarioId(docs?.scenarios[0]?.id || 'general')
      const list = await api.listSessions(docs?.id || 'docs')
      setSessions(list)
      if (list[0]) await selectSession(list[0].id)
    } catch (e) {
      setBootError(
        e instanceof Error ? e.message : '无法连接后端，请先启动 server',
      )
    } finally {
      setLoading(false)
    }
  }, [selectSession])

  const value = useMemo<WorkbenchValue>(
    () => ({
      catalog,
      modules,
      activeModuleId,
      activeScenarioId,
      activeModule,
      activeScenario,
      sessions,
      currentSessionId,
      currentSession,
      messages,
      loading,
      bootError,
      health,
      activeAssistantId,
      isStreaming,
      streamStatus: stream.status,
      moduleAvailable: !!moduleAvailable,
      bootstrap,
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
      currentSessionId,
      currentSession,
      messages,
      loading,
      bootError,
      health,
      activeAssistantId,
      isStreaming,
      stream.status,
      moduleAvailable,
      bootstrap,
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
