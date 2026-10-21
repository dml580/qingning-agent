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
}

export interface SessionDetail extends Session {
  messages: Message[]
}
