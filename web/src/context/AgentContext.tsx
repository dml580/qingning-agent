/**
 * Agent state: modules/scenarios + sessions + stream lifecycle.
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

interface AgentValue {
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
  setScenario: (scenarioId: string) => void
  selectSession: (id: string) => Promise<void>
  createSession: () => void
  removeSession: (id: string) => Promise<void>
  send: (payload: {
    text: string
    imageBase64?: string
    imageMime?: string
  }) => Promise<void>
  cancel: () => Promise<void>
  retry: (failedMessageId: string) => Promise<void>
  actOnAgentStep: (
    messageId: string,
    stepIndex: number,
    action: 'approve' | 'reject' | 'retry',
  ) => Promise<void>
}

const AgentContext = createContext<AgentValue | null>(null)

export function AgentProvider({ children }: { children: ReactNode }) {
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

  const sessionsRef = useRef(sessions)
  sessionsRef.current = sessions

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
        onAgent: (agent) => patchMessage(messageId, { agent }),
        onTool: (events) => patchMessage(messageId, { toolEvents: events }),
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
      } catch {
        // 会话已不存在（例如库里刚清过空壳）：回到无会话空态，并刷新侧栏
        setCurrentSessionId(null)
        setMessages([])
        try {
          const mid = activeModuleIdRef.current
          setSessions(await api.listSessions(mid))
        } catch {
          /* ignore */
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
      const list = await api.listSessions(moduleId)
      setSessions(list)
      if (list[0]) await selectSession(list[0].id)
    },
    [catalog, selectSession],
  )

  const setScenario = useCallback((scenarioId: string) => {
    if (scenarioId === activeScenarioIdRef.current) return
    setActiveScenarioId(scenarioId)
    const sid = currentSessionIdRef.current
    if (!sid) return
    const current = sessionsRef.current.find((s) => s.id === sid)
    if (current?.scenario_id === scenarioId) return
    // 换文书类型另起一条，不改写已经生成的记录
    if (isStreamingRef.current) {
      streamRef.current.stop()
      setActiveAssistantId(null)
    }
    setCurrentSessionId(null)
    setMessages([])
  }, [])

  const clearActionError = useCallback(() => setActionError(null), [])

  const createSession = useCallback(() => {
    if (!moduleAvailable) return
    setActionError(null)
    if (isStreamingRef.current) {
      streamRef.current.stop()
      setActiveAssistantId(null)
    }
    // 先留白；发出第一条消息后才写入记录，旧记录保留
    setCurrentSessionId(null)
    setMessages([])
  }, [moduleAvailable])

  const removeSession = useCallback(
    async (id: string) => {
      setActionError(null)
      try {
        const mid = activeModuleIdRef.current
        await api.deleteSession(id)
        const next = await api.listSessions(mid)
        setSessions(next)
        if (currentSessionIdRef.current === id) {
          streamRef.current.stop()
          setActiveAssistantId(null)
          if (next[0]) await selectSession(next[0].id)
          else {
            setCurrentSessionId(null)
            setMessages([])
          }
        }
      } catch (e) {
        setActionError(
          e instanceof Error
            ? e.message
            : '删除失败，记录可能仍留在本机数据库中。',
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
        if (!sid) {
          const s = await api.createSession('新会话', mid, scen)
          setSessions((prev) => [s, ...prev])
          sid = s.id
          setCurrentSessionId(sid)
          setMessages([])
        }
        // 文书默认走迷你 RAG；短文由后端自动跳过，不暴露开关给用户
        // 工具调用（抽条款 / 提醒 / 联网 / 天气 / 时间）默认开启
        const { user_message, assistant_message, rag } = await api.sendMessage(
          sid,
          text || (payload.imageBase64 ? '请根据上传的文书照片进行分析' : ''),
          mid,
          scen,
          payload.imageBase64
            ? { base64: payload.imageBase64, mime: payload.imageMime }
            : undefined,
          mid === 'docs',
          true,
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
          useAgent: true,
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

  const actOnAgentStep = useCallback(async (
    messageId: string,
    stepIndex: number,
    action: 'approve' | 'reject' | 'retry',
  ) => {
    const message = messagesRef.current.find((item) => item.id === messageId)
    const runId = message?.agent?.run_id
    if (!runId) throw new Error('找不到该任务的运行记录')
    const response = await api.agentStepAction(runId, stepIndex, action)
    const nextStatus = response.step.status as
      | 'completed' | 'failed' | 'waiting_confirmation' | 'rejected'
    patchMessage(messageId, {
      agent: message.agent
        ? {
            ...message.agent,
            calls: message.agent.calls.map((call) =>
              call.step_index === stepIndex
                ? {
                    ...call,
                    ok: response.ok,
                    status: nextStatus,
                    summary:
                      String(response.step.result.error || '') ||
                      (response.ok ? '步骤已执行' : '步骤执行失败'),
                  }
                : call,
            ),
          }
        : undefined,
    })
  }, [patchMessage])

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
      const list = await api.listSessions(docsId)
      setSessions(list)
      if (list[0]) {
        await selectSession(list[0].id)
      } else {
        setActiveScenarioId(firstScen)
        setCurrentSessionId(null)
        setMessages([])
      }
    } catch (e) {
      setBootError(
        e instanceof Error ? e.message : '无法连接后端，请先启动 server',
      )
    } finally {
      setLoading(false)
    }
  }, [selectSession])

  const value = useMemo<AgentValue>(
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
      actOnAgentStep,
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
    <AgentContext.Provider value={value}>
      {children}
    </AgentContext.Provider>
  )
}

export function useAgent() {
  const ctx = useContext(AgentContext)
  if (!ctx) throw new Error('useAgent must be used within AgentProvider')
  return ctx
}
