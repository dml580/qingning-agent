/**
 * SSE consumer:
 * - status: connecting → generating → completed | failed | cancelled
 * - seq dedupe (never apply the same chunk twice)
 * - reconnect via from_seq (+ browser Last-Event-ID)
 * - user cancel closes EventSource; server settles cancelled
 */

import { useCallback, useRef, useState } from 'react'
import { api } from '../api/client'
import type { AgentMeta, MessageStatus, ToolEvent } from '../types'

export interface StreamHandlers {
  onStatus?: (status: MessageStatus) => void
  onChunk?: (seq: number, text: string) => void
  onAgent?: (agent: AgentMeta) => void
  onTool?: (events: ToolEvent[]) => void
  onDone?: (status: MessageStatus, content: string) => void
  onError?: (error: string, content?: string) => void
}

export function useSseStream() {
  const [status, setStatus] = useState<MessageStatus | 'idle'>('idle')
  const [lastSeq, setLastSeq] = useState(-1)
  const [error, setError] = useState<string | null>(null)

  const esRef = useRef<EventSource | null>(null)
  const sessionIdRef = useRef('')
  const messageIdRef = useRef('')
  const handlersRef = useRef<StreamHandlers>({})
  const intentionalCloseRef = useRef(false)
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const reconnectAttemptsRef = useRef(0)
  const lastSeqRef = useRef(-1)

  const clearReconnect = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
  }, [])

  const closeEs = useCallback(() => {
    if (esRef.current) {
      esRef.current.close()
      esRef.current = null
    }
  }, [])

  const applyChunk = useCallback((seq: number, text: string) => {
    if (seq <= lastSeqRef.current) return
    lastSeqRef.current = seq
    setLastSeq(seq)
    handlersRef.current.onChunk?.(seq, text)
  }, [])

  const open = useCallback(
    (fromSeq: number) => {
      closeEs()
      intentionalCloseRef.current = false
      const url = api.streamUrl(
        sessionIdRef.current,
        messageIdRef.current,
        fromSeq,
      )
      const es = new EventSource(url)
      esRef.current = es

      es.addEventListener('status', (ev) => {
        const data = JSON.parse((ev as MessageEvent).data) as {
          status: MessageStatus
        }
        setStatus(data.status)
        handlersRef.current.onStatus?.(data.status)
      })

      es.addEventListener('chunk', (ev) => {
        const data = JSON.parse((ev as MessageEvent).data) as {
          seq: number
          text: string
        }
        setStatus((prev) => {
          if (prev === 'connecting') {
            handlersRef.current.onStatus?.('generating')
            return 'generating'
          }
          return prev
        })
        applyChunk(data.seq, data.text)
      })

      es.addEventListener('agent', (ev) => {
        const data = JSON.parse((ev as MessageEvent).data) as {
          agent: AgentMeta
        }
        if (data.agent) handlersRef.current.onAgent?.(data.agent)
      })

      es.addEventListener('tool', (ev) => {
        const data = JSON.parse((ev as MessageEvent).data) as {
          events?: ToolEvent[]
        }
        if (data.events) handlersRef.current.onTool?.(data.events)
      })

      es.addEventListener('done', (ev) => {
        const data = JSON.parse((ev as MessageEvent).data) as {
          status: MessageStatus
          content: string
        }
        setStatus(data.status)
        intentionalCloseRef.current = true
        closeEs()
        clearReconnect()
        handlersRef.current.onDone?.(data.status, data.content)
      })

      es.addEventListener('error', (ev) => {
        if (ev instanceof MessageEvent && ev.data) {
          const data = JSON.parse(ev.data) as {
            status: MessageStatus
            error: string
            content?: string
          }
          setStatus('failed')
          setError(data.error)
          intentionalCloseRef.current = true
          closeEs()
          clearReconnect()
          handlersRef.current.onError?.(data.error, data.content)
        }
      })

      es.addEventListener('heartbeat', () => {})

      es.onerror = () => {
        if (intentionalCloseRef.current) return
        closeEs()
        setStatus((prev) => {
          if (
            prev === 'completed' ||
            prev === 'cancelled' ||
            prev === 'failed'
          ) {
            return prev
          }
          handlersRef.current.onStatus?.('connecting')
          return 'connecting'
        })
        clearReconnect()
        const delay = Math.min(1000 * 2 ** reconnectAttemptsRef.current, 8000)
        reconnectAttemptsRef.current += 1
        reconnectTimerRef.current = setTimeout(() => {
          open(lastSeqRef.current + 1)
        }, delay)
      }
    },
    [applyChunk, clearReconnect, closeEs],
  )

  const stop = useCallback(() => {
    intentionalCloseRef.current = true
    clearReconnect()
    closeEs()
  }, [clearReconnect, closeEs])

  const start = useCallback(
    (
      sessionId: string,
      messageId: string,
      fromSeq = 0,
      handlers: StreamHandlers = {},
    ) => {
      stop()
      sessionIdRef.current = sessionId
      messageIdRef.current = messageId
      handlersRef.current = handlers
      lastSeqRef.current = fromSeq - 1
      setLastSeq(fromSeq - 1)
      setError(null)
      reconnectAttemptsRef.current = 0
      setStatus('connecting')
      handlers.onStatus?.('connecting')
      open(fromSeq)
    },
    [open, stop],
  )

  const reconnect = useCallback(() => {
    if (!sessionIdRef.current || !messageIdRef.current) return
    reconnectAttemptsRef.current = 0
    setStatus('connecting')
    handlersRef.current.onStatus?.('connecting')
    open(lastSeqRef.current + 1)
  }, [open])

  return { status, lastSeq, error, start, stop, reconnect }
}
