/**
 * 轻量 Markdown 展示（无额外依赖）：标题 / 加粗 / 列表 / 代码块。
 * 流式过程中仍用纯文本；完成后用此组件，便于 AI 前端作品集演示。
 */

import { useMemo, useState } from 'react'

interface Props {
  text: string
}

type Block =
  | { type: 'heading'; level: 1 | 2 | 3; text: string }
  | { type: 'list'; ordered: boolean; items: string[] }
  | { type: 'code'; lang: string; code: string }
  | { type: 'para'; text: string }

function escapeHtml(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

/** 行内：`code` 与 **bold** */
function inlineHtml(raw: string): string {
  let s = escapeHtml(raw)
  s = s.replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>')
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  return s
}

function parseBlocks(src: string): Block[] {
  const lines = src.replace(/\r\n/g, '\n').split('\n')
  const blocks: Block[] = []
  let i = 0

  while (i < lines.length) {
    const line = lines[i]

    if (line.startsWith('```')) {
      const lang = line.slice(3).trim()
      const buf: string[] = []
      i += 1
      while (i < lines.length && !lines[i].startsWith('```')) {
        buf.push(lines[i])
        i += 1
      }
      if (i < lines.length) i += 1
      blocks.push({ type: 'code', lang, code: buf.join('\n') })
      continue
    }

    const hm = /^(#{1,3})\s+(.+)$/.exec(line)
    if (hm) {
      blocks.push({
        type: 'heading',
        level: hm[1].length as 1 | 2 | 3,
        text: hm[2].trim(),
      })
      i += 1
      continue
    }

    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''))
        i += 1
      }
      blocks.push({ type: 'list', ordered: false, items })
      continue
    }

    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = []
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''))
        i += 1
      }
      blocks.push({ type: 'list', ordered: true, items })
      continue
    }

    if (!line.trim()) {
      i += 1
      continue
    }

    const buf: string[] = [line]
    i += 1
    while (
      i < lines.length &&
      lines[i].trim() &&
      !lines[i].startsWith('#') &&
      !lines[i].startsWith('```') &&
      !/^\s*[-*]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i])
    ) {
      buf.push(lines[i])
      i += 1
    }
    blocks.push({ type: 'para', text: buf.join('\n') })
  }

  return blocks
}

type Section = { title: string | null; blocks: Block[]; collapsible: boolean }

function groupSections(blocks: Block[]): Section[] {
  if (!blocks.length) return []
  const sections: Section[] = []
  let cur: Section = { title: null, blocks: [], collapsible: false }

  const flush = () => {
    if (cur.title || cur.blocks.length) sections.push(cur)
  }

  for (const b of blocks) {
    if (b.type === 'heading' && b.level <= 2) {
      flush()
      const t = b.text
      cur = {
        title: t,
        blocks: [b],
        collapsible: /风险/.test(t),
      }
    } else {
      cur.blocks.push(b)
    }
  }
  flush()
  return sections
}

function CodeBlock({ lang, code }: { lang: string; code: string }) {
  const [copied, setCopied] = useState(false)

  async function onCopy() {
    try {
      await navigator.clipboard.writeText(code)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1400)
    } catch {
      /* ignore */
    }
  }

  return (
    <div className="md-code-wrap">
      <div className="md-code-bar">
        <span className="md-code-lang">{lang || 'text'}</span>
        <button type="button" className="btn ghost small" onClick={() => void onCopy()}>
          {copied ? '已复制' : '复制代码'}
        </button>
      </div>
      <pre className="md-code">
        <code>{code}</code>
      </pre>
    </div>
  )
}

function BlockView({ block }: { block: Block }) {
  if (block.type === 'heading') {
    const Tag = (`h${block.level}` as 'h1' | 'h2' | 'h3')
    return (
      <Tag
        className={`md-h md-h${block.level}`}
        dangerouslySetInnerHTML={{ __html: inlineHtml(block.text) }}
      />
    )
  }
  if (block.type === 'list') {
    const Tag = block.ordered ? 'ol' : 'ul'
    return (
      <Tag className="md-list">
        {block.items.map((it, idx) => (
          <li
            key={idx}
            dangerouslySetInnerHTML={{ __html: inlineHtml(it) }}
          />
        ))}
      </Tag>
    )
  }
  if (block.type === 'code') {
    return <CodeBlock lang={block.lang} code={block.code} />
  }
  return (
    <p
      className="md-p"
      dangerouslySetInnerHTML={{ __html: inlineHtml(block.text) }}
    />
  )
}

export function AssistantMarkdown({ text }: Props) {
  const sections = useMemo(
    () => groupSections(parseBlocks(text || '')),
    [text],
  )

  return (
    <div className="assistant-md">
      {sections.map((sec, si) => {
        const body = (
          <div className="md-section-body">
            {sec.blocks.map((b, bi) => (
              <BlockView key={bi} block={b} />
            ))}
          </div>
        )
        if (!sec.collapsible) {
          return (
            <section key={si} className="md-section">
              {body}
            </section>
          )
        }
        return (
          <details key={si} className="md-section md-fold" open>
            <summary className="md-fold-summary">
              {sec.title || '风险点'}
              <span className="md-fold-hint">点击折叠 / 展开</span>
            </summary>
            <div className="md-section-body">
              {sec.blocks
                .filter((b) => !(b.type === 'heading' && b.level <= 2))
                .map((b, bi) => (
                  <BlockView key={bi} block={b} />
                ))}
            </div>
          </details>
        )
      })}
    </div>
  )
}
