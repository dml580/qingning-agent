type QuickTask = {
  id: string
  title: string
  hint: string
  showPrivacyNotice?: boolean
}

interface Props {
  onSelect: (task: QuickTask) => void
  disabled?: boolean
}

const QUICK_TASKS: QuickTask[] = [
  {
    id: 'contract',
    title: '看合同 / 通知',
    hint: '把合同、协议或通知发给我，我陪你慢慢看看重点。',
    showPrivacyNotice: true,
  },
  {
    id: 'reminder',
    title: '记一个生活提醒',
    hint: '你想记什么提醒，慢慢告诉我就好。',
  },
  {
    id: 'search',
    title: '查实时信息',
    hint: '你想查什么信息，我来陪你一起找。',
  },
  {
    id: 'bill',
    title: '识别账单 / 费用单',
    hint: '把账单或费用单发给我，我帮你一起理清楚。',
    showPrivacyNotice: true,
  },
  {
    id: 'chat',
    title: '随便问问 / 聊聊',
    hint: '想聊什么都可以，我在这儿听着。',
  },
]

export function ScenarioBar({ onSelect, disabled }: Props) {
  return (
    <section className="scenario-bar" aria-label="快捷任务">
      <div className="scenario-bar-copy">
        <h2>今天想先处理哪件事？</h2>
        <p>慢慢说就好，我会陪你一起理清楚。</p>
      </div>
      <div className="quick-task-stack">
        {QUICK_TASKS.map((task) => (
          <button
            key={task.id}
            type="button"
            className="scenario-chip quick-task"
            disabled={disabled}
            onClick={() => onSelect(task)}
          >
            <span className="chip-name">{task.title}</span>
          </button>
        ))}
      </div>
    </section>
  )
}
