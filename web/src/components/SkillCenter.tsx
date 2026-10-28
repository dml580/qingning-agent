import { useEffect, useState } from 'react'
import { api, type CalendarStatus, type ReminderItem } from '../api/client'

interface Props { open: boolean; onClose: () => void }

export function SkillCenter({ open, onClose }: Props) {
  const [tab, setTab] = useState<'todo' | 'calendar' | 'docs' | 'memory'>('todo')
  const [todos, setTodos] = useState<Array<{ id: string; title: string; due_date: string; done: boolean }>>([])
  const [reminders, setReminders] = useState<ReminderItem[]>([])
  const [calendar, setCalendar] = useState<CalendarStatus | null>(null)
  const [docs, setDocs] = useState<Array<{ id: string; kind: string; title: string; summary: string }>>([])
  const [memory, setMemory] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [newTodo, setNewTodo] = useState('')

  useEffect(() => {
    if (!open) return
    setLoading(true)
    void Promise.all([api.listTodos(), api.listReminders({ includeDone: true }), api.calendarStatus(), api.listDocumentCaptures(), api.listMemory()])
      .then(([todoRows, reminderRows, calendarStatus, captureRows, memoryRows]) => { setTodos(todoRows); setReminders(reminderRows); setCalendar(calendarStatus); setDocs(captureRows); setMemory(memoryRows) })
      .finally(() => setLoading(false))
  }, [open])

  if (!open) return null
  async function addTodo() { if (!newTodo.trim()) return; await api.createTodo({ title: newTodo.trim() }); setNewTodo(''); setTodos(await api.listTodos()) }
  async function toggleTodo(item: { id: string; done: boolean }) { await api.patchTodo(item.id, !item.done); setTodos(await api.listTodos()) }
  async function removeTodo(id: string) { if (!window.confirm('确定删除这条待办？')) return; await api.deleteTodo(id); setTodos(await api.listTodos()) }
  async function editMemory(key: string, value: string) { const next = window.prompt('修改记忆', value); if (next === null) return; await api.putMemory(key, next); setMemory(await api.listMemory()) }
  async function removeMemory(key: string) { if (!window.confirm('确定删除这条记忆？')) return; await api.deleteMemory(key); setMemory(await api.listMemory()) }
  const tabs = [['todo', '待办'], ['calendar', '日历'], ['docs', '文档提取'], ['memory', '记忆']] as const
  return <div className="skill-center-overlay" role="presentation" onClick={onClose}>
    <section className="skill-center" role="dialog" aria-modal="true" aria-labelledby="skill-center-title" onClick={(e) => e.stopPropagation()}>
      <header className="skill-center-head"><div><h2 id="skill-center-title">能力管理</h2><p>直接查看 Agent 的待办、日历、文档和记忆数据。</p></div><button className="btn ghost small" onClick={onClose}>关闭</button></header>
      <nav className="skill-tabs" aria-label="能力分类">{tabs.map(([id, label]) => <button key={id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>{label}</button>)}</nav>
      {loading ? <p className="muted skill-empty">加载中…</p> : <div className="skill-content">
        {tab === 'todo' && <><div className="skill-add-row"><input value={newTodo} onChange={(e) => setNewTodo(e.target.value)} placeholder="新增待办" onKeyDown={(e) => { if (e.key === 'Enter') void addTodo() }} /><button className="btn primary small" onClick={() => void addTodo()}>添加</button></div><div className="skill-stat">共 {todos.filter((x) => !x.done).length} 条未完成待办</div>{todos.length ? todos.map((item) => <div className="skill-row" key={item.id}><button className="skill-check" onClick={() => void toggleTodo(item)}>{item.done ? '✓' : '○'}</button><span className={item.done ? 'is-done' : ''}>{item.title}</span><small>{item.done ? '已完成' : item.due_date || '未设日期'} <button className="link" onClick={() => void removeTodo(item.id)}>删除</button></small></div>) : <p className="skill-empty">暂无待办</p>}</>}
        {tab === 'calendar' && <><div className="skill-stat">{calendar?.configured ? `已连接：${calendar.provider}` : '尚未配置日历'}</div>{reminders.length ? reminders.map((item) => <div className="skill-row" key={item.id}><span>{item.title}</span><small>{item.due_date} {item.due_time || ''}{item.calendar_event_id ? ' · 已同步' : ''}</small></div>) : <p className="skill-empty">暂无提醒。</p>}</>}
        {tab === 'docs' && <>{docs.length ? docs.map((item) => <div className="skill-row skill-row-block" key={item.id}><strong>{item.title || item.kind}</strong><small>{item.summary || '暂无摘要'}</small></div>) : <p className="skill-empty">暂无文档提取记录。</p>}</>}
        {tab === 'memory' && <>{Object.keys(memory).length ? Object.entries(memory).map(([key, value]) => <div className="skill-row" key={key}><span>{key}</span><small>{value} <button className="link" onClick={() => void editMemory(key, value)}>编辑</button> <button className="link" onClick={() => void removeMemory(key)}>删除</button></small></div>) : <p className="skill-empty">暂无显式记忆。</p>}</>}
      </div>}
    </section>
  </div>
}
