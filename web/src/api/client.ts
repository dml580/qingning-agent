import type {
  Catalog,
  Message,
  RagMeta,
  Session,
  SessionDetail,
} from '../types'

const BASE = import.meta.env.VITE_API_BASE || ''

function formatApiError(text: string, status: number): string {
  if (status >= 500) return '服务器暂时出错，请稍后重试'
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
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers || {}),
    },
  })
  if (!res.ok) {
    const text = await res.text()
    if (res.status === 401 && !path.startsWith('/api/auth/')) {
      onUnauthorized?.()
    }
    throw new Error(formatApiError(text, res.status))
  }
  return res.json() as Promise<T>
}

/** 会话失效（401）时由 App 注册回到登录页。 */
let onUnauthorized: (() => void) | null = null

export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn
}

export interface AuthStatus {
  configured: boolean
  authenticated: boolean
  user_id?: string | null
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
  due_time: string
  done: boolean
  notify_browser: boolean
  calendar_provider?: string
  calendar_event_id?: string
  calendar_event_url?: string
  created_at: number
  updated_at: number
}

export interface CalendarStatus {
  configured: boolean
  provider: string
  calendar_id: string
  alert_minutes: number
  guide: string
}

export interface SyncCalendarResult {
  ok: boolean
  already_synced?: boolean
  code?: 'not_configured' | 'perm_denied' | 'sync_failed' | string
  reason?: string
  guide?: string
  provider?: string
  event_url?: string
  alert_minutes?: number
  item?: ReminderItem
}

export interface AccountBackup {
  format: 'qingning-account-backup'
  schema_version: number
  user_id: string
  created_at: number
  integrity_sha256: string
  data: Record<string, Array<Record<string, unknown>>>
}

export interface BackupStatus {
  last_export_at: number | null
  last_restore_at: number | null
}

export interface DiagnosticsOverview {
  days: number
  skills: Record<string, { calls: number; success: number; failed: number; success_rate: number; p95_ms: number }>
  confirmation_funnel: { requested: number; waiting: number; approved: number; rejected: number; execution_failed: number }
  llm: { calls: number; failed: number; total_tokens: number; total_ms: number; error_codes: string[] }
}

export const api = {
  health: () => request<HealthInfo>('/api/health'),

  authStatus: () => request<AuthStatus>('/api/auth/status'),

  authSetup: (username: string, password: string) =>
    request<{ ok: boolean; user_id: string }>('/api/auth/setup', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  authLogin: (username: string, password: string) =>
    request<{ ok: boolean; user_id: string }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    }),

  authLogout: () =>
    request<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),

  exportAccountBackup: () => request<AccountBackup>('/api/data/backup'),

  backupStatus: () => request<BackupStatus>('/api/data/backup/status'),
  diagnosticsOverview: () => request<DiagnosticsOverview>('/api/diagnostics/overview?days=7'),
  listTodos: (includeDone = true) => request<Array<{ id: string; title: string; note: string; due_date: string; due_time: string; done: boolean }>>(`/api/todos?include_done=${includeDone}`),
  createTodo: (body: { title: string; note?: string; due_date?: string; due_time?: string }) => request('/api/todos', { method: 'POST', body: JSON.stringify(body) }),
  patchTodo: (id: string, done: boolean) => request(`/api/todos/${id}?done=${done}`, { method: 'PATCH' }),
  deleteTodo: (id: string) => request(`/api/todos/${id}`, { method: 'DELETE' }),
  listMemory: () => request<Record<string, string>>('/api/memory'),
  putMemory: (key: string, value: string) => request(`/api/memory/${encodeURIComponent(key)}`, { method: 'PUT', body: JSON.stringify({ key, value }) }),
  deleteMemory: (key: string) => request(`/api/memory/${encodeURIComponent(key)}`, { method: 'DELETE' }),
  listDocumentCaptures: () => request<Array<{ id: string; kind: string; title: string; summary: string; created_at: number; payload: Record<string, unknown> }>>('/api/document-captures?limit=30'),

  restoreAccountBackup: (backup: AccountBackup, confirmUsername: string) =>
    request<{ ok: boolean; counts: Record<string, number>; restored_at: number }>(
      '/api/data/restore',
      {
        method: 'POST',
        body: JSON.stringify({ backup, confirm_username: confirmUsername }),
      },
    ),

  agentStepAction: (
    runId: string,
    stepIndex: number,
    action: 'approve' | 'reject' | 'retry',
  ) =>
    request<{ ok: boolean; step: { status: string; result: Record<string, unknown> } }>(
      `/api/agent/runs/${runId}/steps/${stepIndex}/${action}`,
      { method: 'POST' },
    ),

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
    due_time?: string
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
      due_time: string
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

  calendarStatus: () => request<CalendarStatus>('/api/calendar/status'),

  syncReminderCalendar: (id: string) =>
    request<SyncCalendarResult>(`/api/reminders/${id}/sync-calendar`, {
      method: 'POST',
    }),

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
    useAgent?: boolean,
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
        use_agent: !!useAgent,
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
      useAgent?: boolean
    },
  ) =>
    request<{
      assistant_message: Message
      rag?: RagMeta
    }>(`/api/sessions/${sessionId}/messages/${messageId}/retry`, {
      method: 'POST',
      body: JSON.stringify({
        use_rag: !!opts?.useRag,
        use_agent: !!opts?.useAgent,
        ...(opts?.prompt ? { prompt: opts.prompt } : {}),
        ...(opts?.moduleId ? { module_id: opts.moduleId } : {}),
        ...(opts?.scenarioId ? { scenario_id: opts.scenarioId } : {}),
      }),
    }),

  streamUrl: (sessionId: string, messageId: string, fromSeq = 0) =>
    `${BASE}/api/sessions/${sessionId}/messages/${messageId}/stream?from_seq=${fromSeq}`,
}
