import { useEffect, useRef, useState } from 'react'
import { api, type AccountBackup, type BackupStatus } from '../api/client'

interface Props {
  open: boolean
  onClose: () => void
  onLogout: () => void
  username: string
  onDataRestored: () => void
}

function formatDate(value: number | null | undefined) {
  return value ? new Date(value * 1000).toLocaleString('zh-CN') : '尚未执行'
}

export function AboutDrawer({ open, onClose, onLogout, username, onDataRestored }: Props) {
  const [backupStatus, setBackupStatus] = useState<BackupStatus | null>(null)
  const [dataBusy, setDataBusy] = useState(false)
  const [dataMessage, setDataMessage] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!open) return
    void api.backupStatus().then(setBackupStatus).catch(() => setBackupStatus(null))
  }, [open])

  async function exportBackup() {
    setDataBusy(true)
    setDataMessage('')
    try {
      const backup = await api.exportAccountBackup()
      const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = `qingning-${username}-${new Date().toISOString().slice(0, 10)}.json`
      link.click()
      URL.revokeObjectURL(url)
      const next = await api.backupStatus()
      setBackupStatus(next)
      setDataMessage('备份已下载。请将文件保存在可靠位置。')
    } catch (error) {
      setDataMessage(error instanceof Error ? error.message : '导出失败')
    } finally {
      setDataBusy(false)
    }
  }

  async function restoreBackup(file: File) {
    setDataBusy(true)
    setDataMessage('')
    try {
      if (file.size > 25 * 1024 * 1024) throw new Error('备份文件不能超过 25MB')
      const backup = JSON.parse(await file.text()) as AccountBackup
      const confirmed = window.prompt(
        `恢复会覆盖账号「${username}」的当前会话、提醒、待办、记忆和 Agent 记录。\n\n请输入当前用户名确认：`,
      )
      if (confirmed === null) return
      if (confirmed !== username) throw new Error('用户名不一致，已取消恢复')
      await api.restoreAccountBackup(backup, confirmed)
      setBackupStatus(await api.backupStatus())
      setDataMessage('恢复完成，页面数据已重新加载。')
      onDataRestored()
    } catch (error) {
      setDataMessage(error instanceof SyntaxError ? '备份文件不是有效 JSON' : error instanceof Error ? error.message : '恢复失败')
    } finally {
      if (fileRef.current) fileRef.current.value = ''
      setDataBusy(false)
    }
  }

  if (!open) return null

  return (
    <div className="about-overlay" role="presentation" onClick={onClose}>
      <aside
        className="about-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="about-title"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="about-head">
          <h2 id="about-title">隐私与使用说明</h2>
          <button type="button" className="btn ghost small" onClick={onClose}>
            关闭
          </button>
        </header>

        <div className="about-body">
          <section>
            <h3>会发到哪里</h3>
            <p>
              你粘贴的文本、上传的文书照片会发往<strong>第三方大模型服务商</strong>
              （当前默认豆包 / 火山方舟）进行分析。请勿粘贴或上传未脱敏的身份证号、银行卡、完整住址、账号密码等极端敏感信息。
            </p>
          </section>

          <section>
            <h3>数据落在哪</h3>
            <ul>
              <li>
                <b>本机：</b>会话与消息保存在后端本地 SQLite（默认
                <code>server/data/</code>），删除记录会从库中清除对应的这一条对话。
              </li>
              <li>
                <b>模型服务商：</b>请求内容由对方按其所政策处理；本产品无法保证对方不留存。
              </li>
            </ul>
          </section>

          <section>
            <h3>本地数据备份</h3>
            <p>
              备份仅包含当前账号的会话、提醒、待办、文档提取、记忆和 Agent 运行记录。
              <strong>不包含密码、登录 Cookie 和模型 API Key。</strong>
            </p>
            <div className="backup-status">
              <span>最近导出：{formatDate(backupStatus?.last_export_at)}</span>
              <span>最近恢复：{formatDate(backupStatus?.last_restore_at)}</span>
            </div>
            <div className="backup-actions">
              <button type="button" className="btn ghost small" disabled={dataBusy} onClick={() => void exportBackup()}>
                {dataBusy ? '处理中…' : '下载当前账号备份'}
              </button>
              <button type="button" className="btn ghost small" disabled={dataBusy} onClick={() => fileRef.current?.click()}>
                从备份恢复
              </button>
              <input
                ref={fileRef}
                className="backup-file-input"
                type="file"
                accept="application/json,.json"
                onChange={(event) => {
                  const file = event.target.files?.[0]
                  if (file) void restoreBackup(file)
                }}
              />
            </div>
            {dataMessage && <p className="backup-message" role="status">{dataMessage}</p>}
          </section>

          <section>
            <h3>结果性质</h3>
            <p>
              分析结果<strong>仅供参考</strong>，不是律师意见，也不是正式法律意见。重要决策请咨询专业人士。
            </p>
          </section>

          <section>
            <h3>责任边界</h3>
            <p>
              因未脱敏、未打码导致的信息泄漏，本产品不承担责任。上传前请自行打码隐私区域。
            </p>
          </section>

          <section>
            <h3>演示模式与模型设置</h3>
            <p>
              若顶栏显示「演示模式」，表示未配置可用的 API
              Key，回复为本地占位。可在「模型设置」中填写密钥（仅存本机后端
              <code>server/data/</code>
              或环境变量），前端不会保存完整 Key。切换提供商后，文书会发往对应服务商。
            </p>
          </section>
          <section>
            <h3>登录</h3>
            <p>
              本产品为单用户本地应用，首次打开时设置的密码用于挡住别人打开此页面；
              登录状态保存在浏览器 Cookie 中，可在下面退出。
            </p>
            <button type="button" className="btn ghost small" onClick={onLogout}>
              退出登录
            </button>
          </section>
        </div>
      </aside>
    </div>
  )
}
