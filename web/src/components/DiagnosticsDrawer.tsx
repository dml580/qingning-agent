import { useEffect, useState } from 'react'
import { api, type DiagnosticsOverview } from '../api/client'

interface Props { open: boolean; onClose: () => void }

export function DiagnosticsDrawer({ open, onClose }: Props) {
  const [data, setData] = useState<DiagnosticsOverview | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    if (!open) return
    setError('')
    void api.diagnosticsOverview().then(setData).catch((reason) => setError(reason instanceof Error ? reason.message : '诊断数据加载失败'))
  }, [open])
  if (!open) return null
  const skills = Object.entries(data?.skills || {})
  return <div className="drawer-backdrop" onClick={onClose}>
    <aside className="drawer diagnostics-drawer" role="dialog" aria-modal="true" aria-labelledby="diagnostics-title" onClick={(event) => event.stopPropagation()}>
      <header className="drawer-head"><div><h2 id="diagnostics-title">开发诊断</h2><p>近 {data?.days || 7} 天，数据仅属于当前账号。</p></div><button className="btn ghost small" onClick={onClose}>关闭</button></header>
      {error ? <div className="inline-error" role="alert">{error}</div> : !data ? <p className="skill-empty">正在聚合运行指标…</p> : <div className="diagnostics-content">
        <section><h3>模型与成本</h3><div className="diagnostic-cards"><div><strong>{data.llm.calls}</strong><span>模型调用</span></div><div><strong>{data.llm.total_tokens}</strong><span>Token</span></div><div><strong>{data.llm.failed}</strong><span>失败</span></div><div><strong>{data.llm.total_ms}ms</strong><span>总耗时</span></div></div></section>
        <section><h3>确认漏斗</h3><div className="diagnostic-cards"><div><strong>{data.confirmation_funnel.requested}</strong><span>请求确认</span></div><div><strong>{data.confirmation_funnel.approved}</strong><span>已批准</span></div><div><strong>{data.confirmation_funnel.rejected}</strong><span>已拒绝</span></div><div><strong>{data.confirmation_funnel.execution_failed}</strong><span>执行失败</span></div></div></section>
        <section><h3>Skill 可靠性</h3>{skills.length ? <div className="diagnostic-table"><div className="diagnostic-table-head"><span>Skill</span><span>成功率</span><span>P95</span><span>调用</span></div>{skills.map(([name, item]) => <div key={name}><span>{name}</span><span>{Math.round(item.success_rate * 100)}%</span><span>{item.p95_ms}ms</span><span>{item.calls}</span></div>)}</div> : <p className="muted">暂无 Skill 运行数据。</p>}</section>
        {!!data.llm.error_codes.length && <section><h3>模型错误摘要</h3><ul>{data.llm.error_codes.map((code) => <li key={code}>{code}</li>)}</ul></section>}
      </div>}
    </aside>
  </div>
}
