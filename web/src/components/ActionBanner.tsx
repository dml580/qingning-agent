interface Props {
  kind?: 'warn' | 'error' | 'info'
  title: string
  detail?: string
  onDismiss?: () => void
  actions?: Array<{ label: string; onClick: () => void }>
}

export function ActionBanner({
  kind = 'warn',
  title,
  detail,
  onDismiss,
  actions,
}: Props) {
  return (
    <div className={`action-banner kind-${kind}`} role="alert">
      <div className="action-banner-body">
        <strong>{title}</strong>
        {detail ? <p>{detail}</p> : null}
        {actions && actions.length > 0 && (
          <div className="action-banner-actions">
            {actions.map((a) => (
              <button
                key={a.label}
                type="button"
                className="btn ghost small"
                onClick={a.onClick}
              >
                {a.label}
              </button>
            ))}
          </div>
        )}
      </div>
      {onDismiss && (
        <button
          type="button"
          className="action-banner-close"
          onClick={onDismiss}
          aria-label="关闭"
        >
          ×
        </button>
      )}
    </div>
  )
}
