import { useCallback, useEffect, useMemo, useState, type ComponentProps } from 'react'
import { api, type ReminderItem } from '../api/client'

type FormSubmitEvent = Parameters<NonNullable<ComponentProps<'form'>['onSubmit']>>[0]

interface Props {
  category?: string
  categoryLabel?: string
  compact?: boolean
}

const PROVIDER_LABELS: Record<string, string> = {
  local: '本机日历',
  google: 'Google 日历',
  feishu: '飞书日历',
}

function providerLabel(provider?: string): string {
  if (!provider) return '日历'
  return PROVIDER_LABELS[provider] || provider
}

function todayLocal(): string {
  const d = new Date()
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function splitDateParts(value: string) {
  const [year, month, day] = value.split('-')
  return {
    year: year || '',
    month: month || '01',
    day: day || '01',
  }
}

function joinDateParts(year: string, month: string, day: string) {
  return `${year}-${month}-${day}`
}

function daysInMonth(year: number, month: number) {
  return new Date(year, month, 0).getDate()
}

function yearOptions(anchorYear: number) {
  return Array.from({ length: 26 }, (_, index) => String(anchorYear - 5 + index))
}

function daysUntil(due: string, today: string): number {
  const a = new Date(due + 'T12:00:00').getTime()
  const b = new Date(today + 'T12:00:00').getTime()
  return Math.round((a - b) / 86400000)
}

function reminderDueMs(item: ReminderItem): number | null {
  if (!item.due_time) return null
  const ms = new Date(`${item.due_date}T${item.due_time}:00`).getTime()
  return Number.isFinite(ms) ? ms : null
}

function statusLabel(due: string, today: string): { text: string; kind: string } {
  const n = daysUntil(due, today)
  if (n < 0) return { text: `已错过 ${-n} 天`, kind: 'overdue' }
  if (n === 0) return { text: '今天提醒', kind: 'today' }
  if (n <= 7) return { text: `${n} 天后提醒`, kind: 'soon' }
  return { text: due, kind: 'later' }
}

const NOTIFY_KEY = 'qingning_reminder_notified_v2'

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
  const now = new Date()
  for (const item of items) {
    if (!item.notify_browser || item.done) continue
    const dueMs = reminderDueMs(item)
    const isDue = dueMs != null ? now.getTime() >= dueMs : item.due_date <= today
    if (!isDue) continue
    const stamp = `${item.due_date} ${item.due_time || 'date'}`
    if (notified[item.id] === stamp) continue
    const tag = item.due_time
      ? `到点提醒 ${item.due_time}`
      : item.due_date < today
        ? '已过期'
        : '今天到期'
    try {
      new Notification(`青柠提醒 · ${tag}`, {
        body: `${item.title}${item.note ? ` — ${item.note}` : ''}`,
        tag: `qingning-rem-${item.id}-${stamp}`,
      })
      markNotified(item.id, stamp)
    } catch {
      /* ignore */
    }
  }
}

export function ReminderBoard({
  category,
  categoryLabel = '提醒面板',
  compact = false,
}: Props) {
  const today = todayLocal()
  const todayParts = splitDateParts(today)
  const [items, setItems] = useState<ReminderItem[]>([])
  const [listFilter, setListFilter] = useState<'todo' | 'urgent' | 'done'>('todo')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [dateYear, setDateYear] = useState(todayParts.year)
  const [dateMonth, setDateMonth] = useState(todayParts.month)
  const [dateDay, setDateDay] = useState(todayParts.day)
  const [dueTime, setDueTime] = useState('')
  const dueTimeParts = dueTime ? dueTime.split(':') : ['', '']
  const [formCategory, setFormCategory] = useState<string>(category || 'medicine')
  const [notifyBrowser, setNotifyBrowser] = useState(true)
  const [saving, setSaving] = useState(false)
  const dueDate = useMemo(
    () => joinDateParts(dateYear, dateMonth, dateDay),
    [dateDay, dateMonth, dateYear],
  )
  const availableYears = useMemo(
    () => yearOptions(Number(todayParts.year)),
    [todayParts.year],
  )
  const availableDays = useMemo(() => {
    const year = Number(dateYear) || Number(todayParts.year)
    const month = Number(dateMonth) || Number(todayParts.month)
    const total = daysInMonth(year, month)
    return Array.from({ length: total }, (_, index) =>
      String(index + 1).padStart(2, '0'),
    )
  }, [dateMonth, dateYear, todayParts.month, todayParts.year])

  useEffect(() => {
    if (!availableDays.includes(dateDay)) {
      setDateDay(availableDays[availableDays.length - 1] || '01')
    }
  }, [availableDays, dateDay])

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const list = await api.listReminders({
        category: category || undefined,
        includeDone: true,
      })
      setItems(list)
      const due = await api.dueReminders({ today, withinDays: 0 })
      const forCat = category ? due.items.filter((i) => i.category === category) : due.items
      await maybeNotify(forCat, today)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载提醒失败')
    } finally {
      setLoading(false)
    }
  }, [category, today])

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
    return { overdue, todayList, upcoming, doneList, todoList: [...overdue, ...todayList, ...upcoming] }
  }, [items, today])

  const onSubmit = async (e: FormSubmitEvent) => {
    e.preventDefault()
    if (!title.trim() || !dueDate) return
    let browserNotifyEnabled = notifyBrowser
    if (notifyBrowser && typeof Notification !== 'undefined') {
      if (Notification.permission === 'default') {
        browserNotifyEnabled = (await Notification.requestPermission()) === 'granted'
      } else {
        browserNotifyEnabled = Notification.permission === 'granted'
      }
    } else if (typeof Notification === 'undefined') {
      browserNotifyEnabled = false
    }
    setSaving(true)
    setError(null)
    try {
      await api.createReminder({
        category: category || formCategory,
        title: title.trim(),
        due_date: dueDate,
        due_time: dueTime,
        note: note.trim(),
        notify_browser: browserNotifyEnabled,
      })
      setTitle('')
      setNote('')
      setDateYear(todayParts.year)
      setDateMonth(todayParts.month)
      setDateDay(todayParts.day)
      setDueTime('')
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建失败')
    } finally {
      setSaving(false)
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
        {label ? <h3>{label}<span className="count">{list.length}</span></h3> : null}
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
                      提醒时间 {it.due_date}
                      {it.due_time ? ` ${it.due_time}` : ''}
                      {it.notify_browser && typeof Notification !== 'undefined' && Notification.permission === 'granted'
                        ? ' · 电脑通知已开启'
                        : it.notify_browser
                          ? ' · 电脑通知未授权'
                          : ''}
                      {it.calendar_event_id
                        ? ` · 已同步${providerLabel(it.calendar_provider)}`
                        : ''}
                    </p>
                  </div>
                  <div className="reminder-actions">
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

  const openCount = grouped.overdue.length + grouped.todayList.length + grouped.upcoming.length
  const isMedicine = category === 'medicine'
  const isPet = category === 'pet'
  const isAll = !category

  return (
    <div className={`reminder-board${compact ? ' is-compact' : ''}`}>
      <div className="reminder-intro">
        <h2>{categoryLabel}</h2>
        <p>{isAll ? '管理待办、到期事项与日历提醒。' : '查看和管理提醒。'}</p>
        {isMedicine && (
          <p className="reminder-disclaimer">
            仅作过期/复购备忘，不提供用药剂量、儿童用药或相互作用建议；用药请遵医嘱与说明书。
          </p>
        )}
      </div>

      <form className="reminder-form" onSubmit={onSubmit}>
        <label>
          <span>{isMedicine ? '药品名称' : isPet ? '补给名称' : '事项名称'}</span>
          <input
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder={
              isMedicine
                ? '如：布洛芬混悬液'
                : isPet
                  ? '如：猫粮 / 猫砂'
                  : '如：开会 / 交水电费 / 买猫粮'
            }
            required
            maxLength={120}
          />
        </label>
        {!category && (
          <label>
            <span>分类</span>
            <select value={formCategory} onChange={(e) => setFormCategory(e.target.value)}>
              <option value="medicine">生活提醒</option>
              <option value="pet">宠物补给</option>
            </select>
          </label>
        )}
        <label>
          <span>提醒时间</span>
          <div className="reminder-date-row">
            <select value={dateYear} onChange={(e) => setDateYear(e.target.value)} required>
              {availableYears.map((year) => (
                <option key={year} value={year}>
                  {year} 年
                </option>
              ))}
            </select>
            <select value={dateMonth} onChange={(e) => setDateMonth(e.target.value)} required>
              {Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, '0')).map(
                (month) => (
                  <option key={month} value={month}>
                    {month} 月
                  </option>
                ),
              )}
            </select>
            <select value={dateDay} onChange={(e) => setDateDay(e.target.value)} required>
              {availableDays.map((day) => (
                <option key={day} value={day}>
                  {day} 日
                </option>
              ))}
            </select>
          </div>
        </label>
        <label>
          <span>具体时刻（可选）</span>
          <div className="reminder-time-row">
            <select
              value={dueTimeParts[0]}
              aria-label="提醒小时"
              onChange={(event) => {
                const hour = event.target.value
                setDueTime(hour ? `${hour}:${dueTimeParts[1] || '00'}` : '')
              }}
            >
              <option value="">不设置具体时刻</option>
              {Array.from({ length: 24 }, (_, index) => String(index).padStart(2, '0')).map(
                (hour) => <option key={hour} value={hour}>{hour} 时</option>,
              )}
            </select>
            <select
              value={dueTimeParts[1]}
              aria-label="提醒分钟"
              disabled={!dueTimeParts[0]}
              onChange={(event) => setDueTime(`${dueTimeParts[0]}:${event.target.value}`)}
            >
              {Array.from({ length: 60 }, (_, index) => String(index).padStart(2, '0')).map(
                (minute) => <option key={minute} value={minute}>{minute} 分</option>,
              )}
            </select>
          </div>
        </label>
        <label className="span-2">
          <span>备注（可选）</span>
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={
              isMedicine
                ? '存放位置、规格等（勿写需专业判断的剂量）'
                : isPet
                  ? '规格、余量估计等'
                  : '地点、对象、备注等'
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
          到提醒时间时尝试电脑通知
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
          <section className="reminder-section reminder-filter-section">
            <h3>待办提醒 <span className="count">{items.length}</span></h3>
            <div className="reminder-filter-tabs" role="tablist" aria-label="提醒状态">
              <button className={listFilter === 'todo' ? 'active' : ''} onClick={() => setListFilter('todo')}>待办 <span>{openCount}</span></button>
              <button className={listFilter === 'urgent' ? 'active' : ''} onClick={() => setListFilter('urgent')}>需处理 <span>{grouped.overdue.length + grouped.todayList.length}</span></button>
              <button className={listFilter === 'done' ? 'active' : ''} onClick={() => setListFilter('done')}>已完成 <span>{grouped.doneList.length}</span></button>
            </div>
          </section>
          {renderSection('', listFilter === 'done' ? grouped.doneList : listFilter === 'urgent' ? [...grouped.overdue, ...grouped.todayList] : grouped.todoList, '当前状态下暂无提醒。')}
        </>
      )}
    </div>
  )
}
