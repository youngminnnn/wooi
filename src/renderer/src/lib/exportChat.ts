import type { ChatItem } from '@shared/types'

/** 파일명에 쓸 수 있도록 공백·특수문자를 정리한다. */
function slug(name: string): string {
  return (
    name
      .trim()
      .replace(/[^\w.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'conversation'
  )
}

/** 한 트랜스크립트 항목을 마크다운 조각으로 변환한다(표시되지 않는 항목은 빈 문자열). */
function itemToMarkdown(it: ChatItem): string {
  switch (it.type) {
    case 'user': {
      const files = it.attachments?.length
        ? `\n\n_attachments: ${it.attachments.map((a) => a.name).join(', ')}_`
        : ''
      return `### 🧑 You\n\n${it.text}${files}`
    }
    case 'assistant':
      return `### 🤖 Assistant\n\n${it.text}`
    case 'thinking':
      return `> 💭 _${it.text.replace(/\n/g, '\n> ')}_`
    case 'tool_use':
      return `\`🔧 ${it.name}\`\n\n\`\`\`json\n${JSON.stringify(it.input, null, 2)}\n\`\`\``
    case 'tool_result':
      return `\`\`\`\n${it.text}\n\`\`\``
    case 'bash': {
      // 출력이 개행으로 끝나지 않으면 닫는 펜스가 마지막 줄에 붙어 코드블록이 깨진다 — 개행을 보장한다.
      const out = it.output.endsWith('\n') ? it.output : `${it.output}\n`
      return `\`\`\`sh\n$ ${it.command}\n${out}\`\`\``
    }
    case 'result':
      return `_${it.numTurns} turns · ${(it.durationMs / 1000).toFixed(1)}s · $${it.costUsd.toFixed(4)}_`
    case 'error':
      return `> ⚠️ **Error:** ${it.text}`
    case 'system':
      return `_${it.text}_`
    case 'task':
      return `\`⚙️ Workflow: ${it.name}\` — ${it.description}${it.summary ? `\n\n${it.summary}` : ''}`
    default:
      return ''
  }
}

/** 트랜스크립트를 사람이 읽는 마크다운 문서로 변환한다. */
export function chatToMarkdown(items: ChatItem[], title: string): string {
  const header = `# ${title}\n\n_Exported from Wooi · ${new Date().toISOString()}_\n`
  const body = items.map(itemToMarkdown).filter(Boolean).join('\n\n---\n\n')
  return `${header}\n${body}\n`
}

/** 트랜스크립트를 원본 JSON 으로 직렬화한다(재가공·백업용). */
export function chatToJson(items: ChatItem[], title: string): string {
  return JSON.stringify({ title, exportedAt: new Date().toISOString(), items }, null, 2)
}

/** 브라우저(렌더러)에서 텍스트를 파일로 내려받는다. */
export function downloadText(baseName: string, ext: string, text: string, mime: string): void {
  const blob = new Blob([text], { type: mime })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${slug(baseName)}.${ext}`
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
