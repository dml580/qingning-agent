import type {
  Catalog,
  Message,
  RagMeta,
  Session,
  SessionDetail,
} from '../types'

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
  provider_label?: string
  model: string | null
  configured: boolean
  source?: string
}

export interface LlmProviderInfo {
  id: string
  label: string
  default_base_url: string
  default_model: string
  hint: string
  docs_url: string
}

export interface LlmSettingsResponse {
  providers: LlmProviderInfo[]
  privacy_note: string
  current: {
    provider: string
    provider_label?: string
    model: string
    vision_model: string
    base_url: string
    configured: boolean
    api_key_set: boolean
    api_key_hint: string
    source: string
  }
}

export interface ReminderItem {
  id: string
  category: 'medicine' | 'pet' | string
  title: string
  note: string
  due_date: string
  done: boolean
  notify_browser: boolean
  created_at: number
  updated_at: number
}

export const api = {
  health: () => request<HealthInfo>('/api/health'),

  getLlmSettings: () => request<LlmSettingsResponse>('/api/llm/settings'),

  putLlmSettings: (body: {
    provider: string
    model: string
    vision_model?: string
    base_url?: string
    api_key?: string
  }) =>
    request<LlmSettingsResponse>('/api/llm/settings', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),

  clearLlmSettings: () =>
    request<LlmSettingsResponse>('/api/llm/settings', { method: 'DELETE' }),

  catalog: () => request<Catalog>('/api/catalog'),

  listReminders: (opts?: { category?: string; includeDone?: boolean }) => {
    const q = new URLSearchParams()
    if (opts?.category) q.set('category', opts.category)
    if (opts?.includeDone) q.set('include_done', 'true')
    const qs = q.toString()
    return request<ReminderItem[]>(
      qs ? `/api/reminders?${qs}` : '/api/reminders',
    )
  },

  dueReminders: (opts?: { today?: string; withinDays?: number }) => {
    const q = new URLSearchParams()
    if (opts?.today) q.set('today', opts.today)
    if (opts?.withinDays != null) q.set('within_days', String(opts.withinDays))
    const qs = q.toString()
    return request<{ today: string; items: ReminderItem[] }>(
      qs ? `/api/reminders/due?${qs}` : '/api/reminders/due',
    )
  },

  createReminder: (body: {
    category: string
    title: string
    due_date: string
    note?: string
    notify_browser?: boolean
  }) =>
    request<ReminderItem>('/api/reminders', {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  patchReminder: (
    id: string,
    body: Partial<{
      title: string
      due_date: string
      note: string
      done: boolean
      notify_browser: boolean
      category: string
    }>,
  ) =>
    request<ReminderItem>(`/api/reminders/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),

  deleteReminder: (id: string) =>
    request<{ ok: boolean }>(`/api/reminders/${id}`, { method: 'DELETE' }),

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
    useRag?: boolean,
  ) =>
    request<{
      user_message: Message
      assistant_message: Message
      module_id: string
      scenario_id: string
      rag?: RagMeta
    }>(`/api/sessions/${sessionId}/messages`, {
      method: 'POST',
      body: JSON.stringify({
        content,
        use_rag: !!useRag,
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
    opts?: {
      prompt?: string
      moduleId?: string
      scenarioId?: string
      useRag?: boolean
    },
  ) =>
    request<{
      assistant_message: Message
      rag?: RagMeta
    }>(`/api/sessions/${sessionId}/messages/${messageId}/retry`, {
      method: 'POST',
      body: JSON.stringify({
        use_rag: !!opts?.useRag,
        ...(opts?.prompt ? { prompt: opts.prompt } : {}),
        ...(opts?.moduleId ? { module_id: opts.moduleId } : {}),
        ...(opts?.scenarioId ? { scenario_id: opts.scenarioId } : {}),
      }),
    }),

  streamUrl: (sessionId: string, messageId: string, fromSeq = 0) =>
    `${BASE}/api/sessions/${sessionId}/messages/${messageId}/stream?from_seq=${fromSeq}`,
}
