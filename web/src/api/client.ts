import type { Catalog, Message, Session, SessionDetail } from '../types'

const BASE = import.meta.env.VITE_API_BASE || ''

function formatApiError(text: string, status: number): string {
  try {
    const parsed = JSON.parse(text) as {
      detail?:
        | string
        | { reason?: string; code?: string; msg?: string }
        | Array<{ msg?: string }>
    }
    const d = parsed.detail
    if (typeof d === 'string') return d
    if (d && typeof d === 'object' && !Array.isArray(d)) {
      if (d.reason) return d.reason
      if (d.msg) return d.msg
    }
    if (Array.isArray(d) && d[0]?.msg) return d[0].msg
  } catch {
    /* plain text */
  }
  return text || `HTTP ${status}`
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(formatApiError(text, res.status))
  }
  return res.json() as Promise<T>
}

export interface HealthInfo {
  ok: boolean
  provider: 'doubao' | 'demo' | string
  model: string | null
  configured: boolean
}

export const api = {
  health: () => request<HealthInfo>('/api/health'),

  catalog: () => request<Catalog>('/api/catalog'),

  listSessions: (moduleId?: string) =>
    request<Session[]>(
      moduleId
        ? `/api/sessions?module_id=${encodeURIComponent(moduleId)}`
        : '/api/sessions',
    ),

  createSession: (
    title = '新会话',
    moduleId = 'docs',
    scenarioId = 'general',
  ) =>
    request<Session>('/api/sessions', {
      method: 'POST',
      body: JSON.stringify({
        title,
        module_id: moduleId,
        scenario_id: scenarioId,
      }),
    }),

  patchSession: (id: string, moduleId: string, scenarioId: string) =>
    request<Session>(`/api/sessions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ module_id: moduleId, scenario_id: scenarioId }),
    }),

  getSession: (id: string) => request<SessionDetail>(`/api/sessions/${id}`),

  deleteSession: (id: string) =>
    request<{ ok: boolean }>(`/api/sessions/${id}`, { method: 'DELETE' }),

  reviewImage: (opts: {
    imageBase64: string
    imageMime?: string
    moduleId?: string
    scenarioId?: string
  }) =>
    request<{
      ok: boolean
      related: boolean
      reason: string
      what_you_see?: string
    }>('/api/docs/review-image', {
      method: 'POST',
      body: JSON.stringify({
        image_base64: opts.imageBase64,
        image_mime: opts.imageMime || 'image/jpeg',
        module_id: opts.moduleId || 'docs',
        scenario_id: opts.scenarioId || 'general',
      }),
    }),

  sendMessage: (
    sessionId: string,
    content: string,
    moduleId?: string,
    scenarioId?: string,
    image?: { base64: string; mime?: string },
  ) =>
    request<{
      user_message: Message
      assistant_message: Message
      module_id: string
      scenario_id: string
    }>(`/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content,
        ...(moduleId ? { module_id: moduleId } : {}),
        ...(scenarioId ? { scenario_id: scenarioId } : {}),
        ...(image?.base64
          ? {
              image_base64: image.base64,
              image_mime: image.mime || 'image/jpeg',
            }
          : {}),
      }),
    }),

  cancel: (sessionId: string, messageId: string) =>
    request<{ ok: boolean; message: Message }>(
      `/api/sessions/${sessionId}/messages/${messageId}/cancel`,
      { method: 'POST' },
    ),

  retry: (
    sessionId: string,
    messageId: string,
    opts?: { prompt?: string; moduleId?: string; scenarioId?: string },
  ) =>
    request<{ assistant_message: Message }>(
      `/api/sessions/${sessionId}/messages/${messageId}/retry`,
      {
        method: 'POST',
        body: JSON.stringify({
          ...(opts?.prompt ? { prompt: opts.prompt } : {}),
          ...(opts?.moduleId ? { module_id: opts.moduleId } : {}),
          ...(opts?.scenarioId ? { scenario_id: opts.scenarioId } : {}),
        }),
      },
    ),

  streamUrl: (sessionId: string, messageId: string, fromSeq = 0) =>
    `${BASE}/api/sessions/${sessionId}/messages/${messageId}/stream?from_seq=${fromSeq}`,
}
