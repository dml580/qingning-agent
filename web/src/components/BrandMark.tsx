/** 青柠品牌图标（用户自备图） */
export function BrandMark({ className = '' }: { className?: string }) {
  return (
    <img
      className={`brand-mark-img ${className}`.trim()}
      src="/logo.png"
      alt="青柠"
      width={40}
      height={40}
      draggable={false}
    />
  )
}
