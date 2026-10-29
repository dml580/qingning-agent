import { useCallback, useEffect, useState } from 'react'
import { api, type CalendarStatus, type ReminderItem } from '../api/client'

interface Props { open: boolean; onClose: () => void }
type Tab = 'todo' | 'calendar' | 'docs' | 'memory'
type Todo = { id: string; title: string; due_date: string; done: boolean }
type DocumentCapture = { id: string; kind: string; title: string; summary: string; created_at: number; payload: Record<string, unknown> }
type ConfirmAction = { title: string; detail: string; confirmLabel: string; run: () => Promise<void> }

const tabs: Array<[Tab, string]> = [['todo', '待办'], ['calendar', '日历'], ['docs', '文档提取'], ['memory', '记忆']]
const errorText = (error: unknown) => error instanceof Error ? error.message : '操作失败，请稍后重试'
function valueList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.map((item) => {
    if (typeof item === 'string') return item
    if (item && typeof item === 'object') {
      const row = item as Record<string, unknown>
      return String(row.text || row.value || row.name || JSON.stringify(row))
    }
    return String(item)
  }).filter(Boolean)
}

export function SkillCenter({ open, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('todo')
  const [todos, setTodos] = useState<Todo[]>([])
  const [reminders, setReminders] = useState<ReminderItem[]>([])
  const [calendar, setCalendar] = useState<CalendarStatus | null>(null)
  const [docs, setDocs] = useState<DocumentCapture[]>([])
  const [memory, setMemory] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [newTodo, setNewTodo] = useState('')
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null)
  const [selectedDoc, setSelectedDoc] = useState<DocumentCapture | null>(null)
  const [editingMemory, setEditingMemory] = useState<{ key: string; value: string } | null>(null)

  const loadAll = useCallback(async () => {
    setLoading(true); setError('')
    try {
      const [todoRows, reminderRows, calendarStatus, captureRows, memoryRows] = await Promise.all([
        api.listTodos(), api.listReminders({ includeDone: true }), api.calendarStatus(), api.listDocumentCaptures(), api.listMemory(),
      ])
      setTodos(todoRows); setReminders(reminderRows); setCalendar(calendarStatus); setDocs(captureRows); setMemory(memoryRows)
    } catch (loadError) { setError(`能力数据加载失败：${errorText(loadError)}`) } finally { setLoading(false) }
  }, [])
  useEffect(() => { if (open) void loadAll() }, [open, loadAll])
  if (!open) return null

  async function runOperation(operation: () => Promise<void>) {
    setBusy(true); setError('')
    try { await operation() } catch (operationError) { setError(errorText(operationError)) } finally { setBusy(false) }
  }
  async function addTodo() {
    const title = newTodo.trim()
    if (!title) { setError('请输入待办内容'); return }
    await runOperation(async () => { await api.createTodo({ title }); setNewTodo(''); setTodos(await api.listTodos()) })
  }
  async function toggleTodo(item: Todo) {
    await runOperation(async () => { await api.patchTodo(item.id, !item.done); setTodos(await api.listTodos()) })
  }
  function requestTodoDelete(item: Todo) {
    setConfirmAction({ title: '删除待办？', detail: `“${item.title}”将从当前账号中永久删除。`, confirmLabel: '确认删除', run: async () => { await api.deleteTodo(item.id); setTodos(await api.listTodos()) } })
  }
  async function saveMemory() {
    if (!editingMemory) return
    const value = editingMemory.value.trim()
    if (!value) { setError('记忆内容不能为空'); return }
    await runOperation(async () => { await api.putMemory(editingMemory.key, value); setMemory(await api.listMemory()); setEditingMemory(null) })
  }
  function requestMemoryDelete(key: string) {
    setConfirmAction({ title: '删除记忆？', detail: `Agent 将不再使用“${key}”这条显式记忆。`, confirmLabel: '确认删除', run: async () => { await api.deleteMemory(key); setMemory(await api.listMemory()) } })
  }
  async function confirmPendingAction() {
    if (!confirmAction) return
    await runOperation(async () => { await confirmAction.run(); setConfirmAction(null) })
  }

  return <div className="skill-center-overlay" role="presentation" onClick={onClose}>
    <section className="skill-center" role="dialog" aria-modal="true" aria-labelledby="skill-center-title" onClick={(event) => event.stopPropagation()}>
      <header className="skill-center-head"><div><h2 id="skill-center-title">能力管理</h2><p>管理 Agent 已保存的任务、日历、文档与记忆。</p></div><button className="btn ghost small" onClick={onClose}>关闭</button></header>
      <nav className="skill-tabs" aria-label="能力分类">{tabs.map(([id, label]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => { setTab(id); setError('') }}>{label}</button>)}</nav>
      {error && <div className="skill-error" role="alert"><span>{error}</span><button className="link" onClick={() => void loadAll()}>重新加载</button></div>}
      {loading ? <p className="muted skill-empty" role="status">正在加载能力数据…</p> : <div className="skill-content" aria-busy={busy}>
        {tab === 'todo' && <><div className="skill-add-row"><input value={newTodo} onChange={(event) => setNewTodo(event.target.value)} placeholder="新增待办" onKeyDown={(event) => { if (event.key === 'Enter') void addTodo() }} /><button className="btn primary small" disabled={busy} onClick={() => void addTodo()}>添加</button></div><div className="skill-stat">{todos.filter((item) => !item.done).length} 条未完成 · {todos.filter((item) => item.done).length} 条已完成</div>{todos.length ? todos.map((item) => <div className="skill-row" key={item.id}><button className="skill-check" aria-label={item.done ? `恢复 ${item.title}` : `完成 ${item.title}`} disabled={busy} onClick={() => void toggleTodo(item)}>{item.done ? '✓' : '○'}</button><span className={item.done ? 'is-done' : ''}>{item.title}</span><small>{item.done ? '已完成' : item.due_date || '未设日期'} <button className="link danger-link" onClick={() => requestTodoDelete(item)}>删除</button></small></div>) : <p className="skill-empty">暂无待办</p>}</>}
        {tab === 'calendar' && <><div className="skill-stat">{calendar?.configured ? `已连接 ${calendar.provider} · 提前 ${calendar.alert_minutes} 分钟提醒` : '尚未配置日历，聊天中的写入操作仍会先请求确认'}</div>{reminders.length ? reminders.map((item) => <div className="skill-row" key={item.id}><span>{item.title}</span><small>{item.due_date} {item.due_time || ''}{item.calendar_event_id ? ' · 已同步' : ' · 未同步'}</small></div>) : <p className="skill-empty">暂无可同步提醒</p>}</>}
        {tab === 'docs' && <><div className="skill-stat">{docs.length} 份结构化提取记录</div>{docs.length ? docs.map((item) => <button className="skill-row skill-row-block skill-doc-row" key={item.id} onClick={() => setSelectedDoc(item)}><span className="skill-doc-title"><strong>{item.title || '未命名文档'}</strong><em>{item.kind}</em></span><small>{item.summary || '暂无摘要'}</small><span className="skill-row-action">查看详情</span></button>) : <p className="skill-empty">暂无文档提取记录</p>}</>}
        {tab === 'memory' && <><div className="skill-stat">{Object.keys(memory).length} 条显式记忆，仅对当前账号生效</div>{Object.keys(memory).length ? Object.entries(memory).map(([key, value]) => <div className="skill-row" key={key}><span>{key}</span><small>{value} <button className="link" onClick={() => setEditingMemory({ key, value })}>编辑</button> <button className="link danger-link" onClick={() => requestMemoryDelete(key)}>删除</button></small></div>) : <p className="skill-empty">暂无显式记忆</p>}</>}
      </div>}
    </section>
    {confirmAction && <section className="skill-subdialog confirm-card" role="alertdialog" aria-modal="true" aria-labelledby="confirm-card-title" onClick={(event) => event.stopPropagation()}><span className="confirm-kicker">敏感操作确认</span><h3 id="confirm-card-title">{confirmAction.title}</h3><p>{confirmAction.detail}</p><div className="skill-dialog-actions"><button className="btn ghost" disabled={busy} onClick={() => setConfirmAction(null)}>取消</button><button className="btn danger" disabled={busy} onClick={() => void confirmPendingAction()}>{busy ? '处理中…' : confirmAction.confirmLabel}</button></div></section>}
    {editingMemory && <section className="skill-subdialog" role="dialog" aria-modal="true" aria-labelledby="memory-edit-title" onClick={(event) => event.stopPropagation()}><h3 id="memory-edit-title">编辑记忆</h3><label><span>{editingMemory.key}</span><textarea value={editingMemory.value} onChange={(event) => setEditingMemory({ ...editingMemory, value: event.target.value })} /></label><div className="skill-dialog-actions"><button className="btn ghost" onClick={() => setEditingMemory(null)}>取消</button><button className="btn primary" disabled={busy} onClick={() => void saveMemory()}>保存</button></div></section>}
    {selectedDoc && <section className="skill-subdialog skill-doc-detail" role="dialog" aria-modal="true" aria-labelledby="document-detail-title" onClick={(event) => event.stopPropagation()}><header><div><span className="confirm-kicker">{selectedDoc.kind}</span><h3 id="document-detail-title">{selectedDoc.title || '文档提取详情'}</h3></div><button className="btn ghost small" onClick={() => setSelectedDoc(null)}>关闭</button></header><p className="doc-summary">{selectedDoc.summary || '暂无摘要'}</p>{[['金额', valueList(selectedDoc.payload.amounts)], ['日期', valueList(selectedDoc.payload.dates)], ['关键点', valueList(selectedDoc.payload.key_points)], ['缺失条款', valueList(selectedDoc.payload.missing_clauses)]].map(([label, rows]) => (rows as string[]).length ? <div className="doc-detail-group" key={label as string}><strong>{label as string}</strong><ul>{(rows as string[]).map((row, index) => <li key={`${label}-${index}`}>{row}</li>)}</ul></div> : null)}</section>}
  </div>
}
