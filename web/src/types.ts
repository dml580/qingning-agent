/** Domain types — mirrors server message status machine. */

export type MessageStatus =
  | 'connecting'
  | 'generating'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type MessageRole = 'user' | 'assistant'

export type ModuleStatus = 'available' | 'coming_soon'

export interface Scenario {
  id: string
  name: string
  blurb: string
  placeholder: string
  /** 不在文书模版条 / 侧栏槽位展示（如桌宠闲聊） */
  hidden?: boolean
}

export interface AppModule {
  id: string
  name: string
  name_en: string
  blurb: string
  status: ModuleStatus
  scenarios: Scenario[]
}

export interface Catalog {
  modules: AppModule[]
}

export interface Session {
  id: string
  title: string
  created_at: number
  updated_at: number
  module_id: string
  scenario_id: string
}

export interface RagMeta {
  requested: boolean
  enabled: boolean
  reason?: string
  chunks?: { id: number; score: number; preview: string }[]
}

export interface AgentCall {
  name: string
  label: string
  ok: boolean
  summary: string
  step_index?: number
  status?: 'completed' | 'failed' | 'waiting_confirmation' | 'rejected'
  code?: string
}

export interface AgentMeta {
  enabled: boolean
  wrote_reminders: boolean
  calls: AgentCall[]
  run_id?: string
}

/** 流式 tool 事件：工具执行过程中的增量状态（SSE tool 事件，不落库）。 */
export interface ToolEvent {
  seq: number
  phase: 'planning' | 'running' | 'done' | 'idle'
  name?: string
  label?: string
  ok?: boolean
  summary?: string
}

export interface Message {
  id: string
  session_id: string
  role: MessageRole
  content: string
  status: MessageStatus
  chunks?: { seq: number; text: string }[]
  error?: string | null
  created_at: number
  updated_at: number
  /** Client-only: last applied chunk seq for dedupe. */
  lastSeq?: number
  /** Client-only: 本轮是否走了迷你 RAG（接口返回，不落库）。 */
  rag?: RagMeta
  /** Client-only: 本轮模型调用了哪些本机工具（SSE agent 事件，不落库）。 */
  agent?: AgentMeta
  /** Client-only: 工具执行过程的增量事件（SSE tool 事件，不落库）。 */
  toolEvents?: ToolEvent[]
}

export interface SessionDetail extends Session {
  messages: Message[]
}
