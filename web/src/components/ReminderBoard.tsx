import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react'
import { api, type ReminderItem } from '../api/client'

interface Props {
  category: string
  categoryLabel: string
}

function todayLocal(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function daysUntil(due: string, today: string): number {
  const a = new Date(due + 'T12:00:00').getTime()
  const b = new Date(today + 'T12:00:00').getTime()
  return Math.round((a - b) / 86400000)
}

function statusLabel(due: string, today: string): { text: string; kind: string } {
  const n = daysUntil(due, today)
  if (n < 0) return { text: `已过期 ${-n} 天`, kind: 'overdue' }
  if (n === 0) return { text: '今天到期', kind: 'today' }
  if (n <= 7) return { text: `${n} 天后`, kind: 'soon' }
  return { text: due, kind: 'later' }
}

const NOTIFY_KEY = 'qingning_reminder_notified'

function loadNotified(): Record<string, string> {
  try {
    return JSON.parse(localStorage.getItem(NOTIFY_KEY) || '{}') as Record<
      string,
      string
    >
  } catch {
    return {}
  }
}

function markNotified(id: string, day: string) {
  const map = loadNotified()
  map[id] = day
  localStorage.setItem(NOTIFY_KEY, JSON.stringify(map))
}

async function maybeNotify(items: ReminderItem[], today: string) {
  if (typeof Notification === 'undefined') return
  if (Notification.permission !== 'granted') return
  const notified = loadNotified()
  for (const item of items) {
    if (!item.notify_browser || item.done) continue
    const n = daysUntil(item.due_date, today)
    if (n > 0) continue
    if (notified[item.id] === today) continue
    const tag = n < 0 ? '已过期' : '今天到期'
    try {
      new Notification(`青柠提醒 · ${tag}`, {
        body: `${item.title}${item.note ? ` — ${item.note}` : ''}`,
        tag: `qingning-rem-${item.id}`,
      })
      markNotified(item.id, today)
    } catch {
      /* ignore */
    }
  }
}

export function ReminderBoard({ category, categoryLabel }: Props) {
  const today = todayLocal()
  const [items, setItems] = useState<ReminderItem[]>([])
  const [includeDone, setIncludeDone] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [dueDate, setDueDate] = useState(today)
  const [notifyBrowser, setNotifyBrowser] = useState(true)
  const [perm, setPerm] = useState<NotificationPermission | 'unsupported'>(
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  )
  const [saving, setSaving] = useState(false)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await api.listReminders({
        category,
        includeDone,
      })
      setItems(list)
      const due = await api.dueReminders({ today, withinDays: 0 })
      const forCat = due.items.filter((i) => i.category === category)
      await maybeNotify(forCat, today)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载提醒失败')
    } finally {
      setLoading(false)
    }
  }, [category, includeDone, today])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const grouped = useMemo(() => {
    const overdue: ReminderItem[] = []
    const todayList: ReminderItem[] = []
    const upcoming: ReminderItem[] = []
    const doneList: ReminderItem[] = []
    for (const it of items) {
      if (it.done) {
        doneList.push(it)
        continue
      }
      const n = daysUntil(it.due_date, today)
      if (n < 0) overdue.push(it)
      else if (n === 0) todayList.push(it)
      else upcoming.push(it)
    }
    return { overdue, todayList, upcoming, doneList }
  }, [items, today])

  async function requestPermission() {
    if (typeof Notification === 'undefined') return
    const p = await Notification.requestPermission()
    setPerm(p)
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault()
    if (!title.trim() || !dueDate) return
    setSaving(true)
    setError(null)
    try {
      await api.createReminder({
        category,
        title: title.trim(),
        due_date: dueDate,
        note: note.trim(),
        notify_browser: notifyBrowser,
      })
      setTitle('')
      setNote('')
      setDueDate(today)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败')
    } finally {
      setSaving(false)
    }
  }

  async function toggleDone(item: ReminderItem) {
    try {
      await api.patchReminder(item.id, { done: !item.done })
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '更新失败')
    }
  }

  async function remove(item: ReminderItem) {
    if (!window.confirm(`删除「${item.title}」？`)) return
    try {
      await api.deleteReminder(item.id)
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '删除失败')
    }
  }

  function renderSection(
    label: string,
    list: ReminderItem[],
    emptyHint?: string,
  ) {
    if (!list.length && !emptyHint) return null
    return (
      <section className="reminder-section">
        <h3>
          {label}
          <span className="count">{list.length}</span>
        </h3>
        {!list.length ? (
          <p className="muted">{emptyHint}</p>
        ) : (
          <ul className="reminder-list">
            {list.map((it) => {
              const st = statusLabel(it.due_date, today)
              return (
                <li key={it.id} className={`reminder-card kind-${st.kind}`}>
                  <div className="reminder-main">
                    <div className="reminder-title-row">
                      <strong>{it.title}</strong>
                      <span className={`due-chip ${st.kind}`}>{st.text}</span>
                    </div>
                    {it.note ? <p className="reminder-note">{it.note}</p> : null}
                    <p className="reminder-meta">
                      到期 {it.due_date}
                      {it.notify_browser ? ' · 允许电脑通知' : ''}
                    </p>
                  </div>
                  <div className="reminder-actions">
                    <button
                      type="button"
                      className="btn ghost small"
                      onClick={() => void toggleDone(it)}
                    >
                      {it.done ? '标为未完成' : '完成'}
                    </button>
                    <button
                      type="button"
                      className="link"
                      onClick={() => void remove(it)}
                    >
                      删除
                    </button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    )
  }

  const isMedicine = category === 'medicine'

  return (
    <div className="reminder-board">
      <div className="reminder-intro">
        <h2>{categoryLabel}</h2>
        <p>
          打开本页即可看到到期与过期项。可选开启<strong>电脑浏览器通知</strong>
          （不依赖手机）。数据保存在本机 SQLite，无需登录。
        </p>
        {isMedicine && (
          <p className="reminder-disclaimer">
            仅作过期/复购备忘，不提供用药剂量、儿童用药或相互作用建议；用药请遵医嘱与说明书。
          </p>
        )}
      </div>

      <div className="reminder-notify-bar">
        {perm === 'unsupported' ? (
          <span className="muted">当前浏览器不支持桌面通知，请依赖打开看板查看。</span>
        ) : perm === 'granted' ? (
          <span className="ok-msg">已允许电脑通知：今天到期/过期时会尝试提醒一次。</span>
        ) : (
          <button type="button" className="btn ghost small" onClick={() => void requestPermission()}>
            允许电脑桌面通知
          </button>
        )}
        <label className="reminder-check">
          <input
            type="checkbox"
            checked={includeDone}
            onChange={(e) => setIncludeDone(e.target.checked)}
          />
          显示已完成
        </label>
      </div>

      <form className="reminder-form" onSubmit={onSubmit}>
        <label>
          <span>{isMedicine ? '药品名称' : '补给名称'}</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={isMedicine ? '如：布洛芬混悬液' : '如：猫粮 / 猫砂'}
            required
            maxLength={120}
          />
        </label>
        <label>
          <span>到期日</span>
          <input
            type="date"
            value={dueDate}
            onChange={(e) => setDueDate(e.target.value)}
            required
          />
        </label>
        <label className="span-2">
          <span>备注（可选）</span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={
              isMedicine ? '存放位置、规格等（勿写需专业判断的剂量）' : '规格、余量估计等'
            }
            maxLength={500}
          />
        </label>
        <label className="reminder-check span-2">
          <input
            type="checkbox"
            checked={notifyBrowser}
            onChange={(e) => setNotifyBrowser(e.target.checked)}
          />
          到期时尝试电脑通知
        </label>
        <div className="span-2">
          <button type="submit" className="btn primary" disabled={saving}>
            {saving ? '保存中…' : '添加提醒'}
          </button>
        </div>
      </form>

      {error && (
        <div className="inline-error" role="alert">
          {error}
        </div>
      )}

      {loading ? (
        <p className="muted">加载中…</p>
      ) : (
        <>
          {renderSection('已过期', grouped.overdue)}
          {renderSection('今天到期', grouped.todayList)}
          {renderSection(
            '即将到期',
            grouped.upcoming,
            !grouped.overdue.length &&
              !grouped.todayList.length &&
              !grouped.upcoming.length
              ? '暂无未完成提醒，在上方添加一条吧。'
              : undefined,
          )}
          {includeDone && renderSection('已完成', grouped.doneList)}
        </>
      )}
    </div>
  )
}
