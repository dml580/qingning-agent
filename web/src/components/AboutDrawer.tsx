interface Props {
  open: boolean
  onClose: () => void
}

export function AboutDrawer({ open, onClose }: Props) {
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
                <code>server/data/</code>），删除会话会从库中清除对应记录。
              </li>
              <li>
                <b>模型服务商：</b>请求内容由对方按其所政策处理；本产品无法保证对方不留存。
              </li>
            </ul>
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
        </div>
      </aside>
    </div>
  )
}
