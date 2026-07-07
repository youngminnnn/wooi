import { useEffect, useMemo, useRef, useState } from 'react'
import {
  Send,
  Square,
  Terminal as TerminalIcon,
  MessageCircleQuestion,
  X,
  Clock,
  ImageIcon,
  Loader2,
  Plug,
  RefreshCw,
  Gauge,
  Receipt,
  Bot,
  GitBranch,
  Folder,
  ChevronRight,
  ArrowLeft,
  RotateCw,
  Power,
  PowerOff,
  Cpu,
  Zap,
  Check,
  History,
  ShieldCheck,
  RotateCcw
} from 'lucide-react'
import { useStore } from '../store'
import { PERMISSION_FOOTER } from '../lib/permission'
import { MODEL_OPTIONS, modelLabel } from '../lib/models'
import { EFFORT_OPTIONS, effortLabel } from '../lib/effort'
import { INTERACTIVE_COMMANDS } from '@shared/types'
import type {
  ChatItem,
  CommandPanelKind,
  CommandResult,
  EffortSetting,
  ImageAttachment,
  ImageMediaType,
  McpAction,
  McpServerInfo,
  PermissionsInfo,
  RewindPoint,
  SlashCommandInfo,
  Workspace
} from '@shared/types'

/** Claude 가 받는 이미지 형식. 클립보드의 다른 형식은 붙여넣기 시 무시한다. */
const IMAGE_TYPES: Record<string, ImageMediaType> = {
  'image/png': 'image/png',
  'image/jpeg': 'image/jpeg',
  'image/gif': 'image/gif',
  'image/webp': 'image/webp'
}

/** 화면에 띄우는 붙여넣기 이미지: 전송용 base64 + 썸네일용 data URL. */
type PendingImage = ImageAttachment & { id: string; previewUrl: string }

/** Blob → 순수 base64(+data URL). FileReader 로 읽어 "data:...;base64," 접두사를 떼어 본문만 남긴다. */
function readImage(blob: Blob): Promise<{ dataBase64: string; dataUrl: string }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = String(reader.result)
      resolve({ dataBase64: dataUrl.slice(dataUrl.indexOf(',') + 1), dataUrl })
    }
    reader.onerror = () => reject(reader.error ?? new Error('image read failed'))
    reader.readAsDataURL(blob)
  })
}

export default function Composer({ workspace }: { workspace: Workspace }): React.JSX.Element {
  // 초안은 store 에 보관해 workspace 전환에도 살아남는다(작성 중 메시지 분실 방지).
  const text = useStore((s) => s.drafts[workspace.id] ?? '')
  const setDraft = useStore((s) => s.setDraft)
  const items = useStore((s) => s.transcripts[workspace.id]) ?? EMPTY
  // 실행 중 보낸 후속 메시지의 대기 큐(전송 전이라 취소 가능, 턴 종료 시 자동 전송).
  const queue = useStore((s) => s.messageQueue[workspace.id]) ?? EMPTY_QUEUE
  const enqueueMessage = useStore((s) => s.enqueueMessage)
  const removeQueued = useStore((s) => s.removeQueued)
  const pushToast = useStore((s) => s.pushToast)
  const confirm = useStore((s) => s.confirm)
  const resetTranscript = useStore((s) => s.resetTranscript)
  const taRef = useRef<HTMLTextAreaElement>(null)
  // ↑ 로 이전 사용자 메시지를 불러올 때의 커서(끝에서부터). -1 = 미사용.
  const historyIdx = useRef(-1)
  const running = workspace.status === 'running'

  // 슬래시 명령 자동완성: 명령 목록(워크스페이스당 1회 조회)과 메뉴 선택 인덱스.
  const [commands, setCommands] = useState<SlashCommandInfo[] | null>(null)
  const [loadingCommands, setLoadingCommands] = useState(false)
  const [menuIdx, setMenuIdx] = useState(0)

  // /btw 사이드 질문의 임시 답변(트랜스크립트와 분리, 닫으면 사라짐).
  const [sideAnswer, setSideAnswer] = useState<SideAnswer | null>(null)

  // /mcp·/context 등 인터랙티브 명령 결과 카드(임시 표시, 닫으면 사라짐).
  const [commandCard, setCommandCard] = useState<CommandCardState | null>(null)
  // /model·/effort 선택 카드(로컬 처리, 닫으면 사라짐).
  const [pickerCard, setPickerCard] = useState<'model' | 'effort' | null>(null)
  // 카드 응답을 현재 요청과만 맞추기 위한 단조 토큰(워크스페이스/명령 전환 시 stale 응답 무시).
  const cmdSeq = useRef(0)

  // 붙여넣은 이미지 첨부(전송 전 대기). 초안과 달리 워크스페이스 전환 시 비운다(다른 작업으로 새지 않도록).
  const [images, setImages] = useState<PendingImage[]>([])
  // 같은 워크스페이스 안에서 첨부 id 가 겹치지 않도록 하는 단조 카운터.
  const imgSeq = useRef(0)

  // 워크스페이스를 바꾸면 이전 사이드 답변·명령 카드·대기 중 첨부를 치운다(다른 작업으로 새지 않도록).
  useEffect(() => {
    setSideAnswer(null)
    setCommandCard(null)
    setPickerCard(null)
    setImages([])
  }, [workspace.id])

  /** /model·/effort 선택 카드를 연다(다른 카드는 비켜 준다). 상태줄 클릭·슬래시 명령 공용. */
  const openPicker = (kind: 'model' | 'effort'): void => {
    setSideAnswer(null)
    setCommandCard(null)
    setPickerCard(kind)
  }

  const removeImage = (id: string): void => setImages((prev) => prev.filter((i) => i.id !== id))

  /** 클립보드의 이미지를 첨부로 받는다. 이미지가 하나라도 있으면 기본 텍스트 붙여넣기를 막는다. */
  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(e.clipboardData.items)
      .filter((it) => it.kind === 'file' && IMAGE_TYPES[it.type])
      .map((it) => ({ mediaType: IMAGE_TYPES[it.type], file: it.getAsFile() }))
      .filter((x): x is { mediaType: ImageMediaType; file: File } => x.file != null)
    if (!files.length) return // 텍스트 붙여넣기는 그대로 둔다.

    e.preventDefault()
    for (const { mediaType, file } of files) {
      const id = `img:${imgSeq.current++}`
      const ext = mediaType.split('/')[1]
      const name =
        file.name && file.name !== 'image.png' ? file.name : `image-${imgSeq.current}.${ext}`
      void readImage(file).then(({ dataBase64, dataUrl }) => {
        setImages((prev) => [...prev, { id, name, mediaType, dataBase64, previewUrl: dataUrl }])
      })
    }
  }

  // 사이드 질문 스트림 구독. 현재 워크스페이스의 이벤트만, id 로 스트림을 구분해 반영한다.
  useEffect(() => {
    return window.api.onSideQuestion((e) => {
      if (e.workspaceId !== workspace.id) return
      setSideAnswer((prev) => {
        if (e.phase === 'start')
          return { id: e.id, question: e.question, text: '', status: 'streaming' }
        if (!prev || prev.id !== e.id) return prev
        if (e.phase === 'delta') return { ...prev, text: prev.text + e.text }
        if (e.phase === 'done') return { ...prev, status: 'done' }
        return { ...prev, status: 'error', error: e.message }
      })
    })
  }, [workspace.id])

  const setText = (v: string): void => setDraft(workspace.id, v)

  // textarea 높이 자동 조절.
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`
  }, [text])

  // 입력이 "/명령이름" 단계(아직 공백 없음)인지. 이때만 자동완성 메뉴를 띄운다.
  const slashQuery = useMemo(() => {
    const m = /^\/(\S*)$/.exec(text)
    return m ? m[1] : null
  }, [text])

  // "!" 로 시작하면 Claude Code CLI 의 bash 모드처럼 — 메시지가 아니라 터미널 명령으로 다룬다.
  const bashMode = text.startsWith('!')

  // 슬래시 모드 진입 시 명령 목록을 lazy 하게 조회한다.
  useEffect(() => {
    if (slashQuery === null || commands !== null || loadingCommands) return
    setLoadingCommands(true)
    void window.api.commands.list(workspace.id).then((list) => {
      setCommands(list)
      setLoadingCommands(false)
    })
  }, [slashQuery, commands, loadingCommands, workspace.id])

  // 접두사 우선, 없으면 부분일치로 필터링. 접두사 매치를 위로 올린다.
  const matches = useMemo(() => {
    if (slashQuery === null || !commands) return []
    const q = slashQuery.toLowerCase()
    const scored = commands
      .map((c) => {
        // 이름 우선, 없으면 별칭(/cost·/stats 등)으로도 매칭한다.
        const names = [c.name, ...(c.aliases ?? [])].map((n) => n.toLowerCase())
        const rank = names.some((n) => n.startsWith(q))
          ? 0
          : names.some((n) => n.includes(q))
            ? 1
            : 2
        return { c, rank }
      })
      .filter((x) => x.rank < 2)
      .sort((a, b) => a.rank - b.rank || a.c.name.localeCompare(b.c.name))
    return scored.map((x) => x.c)
  }, [slashQuery, commands])

  const menuOpen = slashQuery !== null && (loadingCommands || matches.length > 0)

  useEffect(() => {
    setMenuIdx(0)
  }, [slashQuery])

  // 명령 결과/사이드 답변 카드는 입력창 포커스가 빠져도(카드 스크롤·클릭 등) Esc 로 닫히도록
  // window 레벨에서 키를 받는다. 메뉴가 열려 있을 땐 Esc 가 메뉴 닫기에 쓰이므로 양보한다.
  useEffect(() => {
    if (menuOpen || (!commandCard && !sideAnswer)) return
    const onEsc = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.preventDefault()
      if (commandCard) setCommandCard(null)
      else setSideAnswer(null)
      taRef.current?.focus()
    }
    window.addEventListener('keydown', onEsc)
    return () => window.removeEventListener('keydown', onEsc)
  }, [menuOpen, commandCard, sideAnswer])

  /**
   * "!명령" 을 1회 실행한다(Claude Code CLI bash 모드). 실행했으면 true.
   * 우측 터미널 패널이 아니라 대화 흐름 안에 명령/출력을 인라인으로 보여 준다.
   */
  const runBash = (trimmed: string): boolean => {
    if (images.length || !trimmed.startsWith('!')) return false
    const command = trimmed.slice(1).trim()
    if (!command) return true // "!" 만 입력 — 메시지로 새지 않도록 삼키되 아무것도 실행 안 함.
    void window.api.terminal.exec(workspace.id, command)
    return true
  }

  const send = (): void => {
    const trimmed = text.trim()
    if (!trimmed && !images.length) return // 텍스트도 첨부도 없으면 무시.

    // "!명령" 은 메시지로 보내지 않고 터미널에서 실행한다(Claude Code CLI 의 bash 모드).
    if (runBash(trimmed)) {
      setText('')
      historyIdx.current = -1
      return
    }

    // /model·/effort 는 백엔드 왕복 없이 로컬 선택 카드로 처리한다(첨부가 있으면 일반 전송).
    const picker = images.length ? null : matchPicker(trimmed)
    if (picker) {
      openPicker(picker)
      setText('')
      historyIdx.current = -1
      return
    }

    // /mcp·/context·/reload-plugins 등 인터랙티브(TUI 전용) 명령은 일반 프롬프트로 보내면 동작하지
    // 않으므로 인터셉트해 SDK 제어 메서드로 실행하고 결과를 카드로 보여 준다(첨부가 있으면 일반 전송).
    const interactive = images.length ? null : matchInteractive(trimmed)
    if (interactive) {
      runInteractive(interactive)
      setText('')
      historyIdx.current = -1
      return
    }

    // /diff·/copy·/help·/clear·/memory 는 Ditto UI 에서 직접 처리한다(에이전트로 보내지 않는다).
    // runLocal 이 입력창 텍스트를 알맞게 정리하므로(대부분 비우고, /help 만 '/' 로 메뉴를 띄움)
    // 여기서는 setText 를 호출하지 않는다.
    const local = images.length ? null : matchLocal(trimmed)
    if (local) {
      runLocal(local)
      historyIdx.current = -1
      return
    }

    // /btw 는 사이드 질문으로 분기한다 — 일반 메시지로 보내면 현재 턴 뒤에 큐잉되어 메인 대화에
    // 쌓이므로(=오염), 맥락만 공유하는 임시 질의로 처리하고 답변은 별도 카드로 보여 준다.
    // (사이드 질문은 텍스트 전용 — 첨부가 있으면 일반 메시지로 보낸다.)
    const sideQ = images.length ? null : /^\/btw(?:\s+([\s\S]+))?$/.exec(trimmed)
    if (sideQ) {
      const question = (sideQ[1] ?? '').trim()
      if (!question) return // 질문 없이 "/btw" 만 보낸 경우는 무시.
      setPickerCard(null)
      void window.api.chat.sideQuestion(workspace.id, question)
      setText('')
      historyIdx.current = -1
      return
    }

    // 첨부에서 화면 전용 필드(id·previewUrl)를 떼고 전송용 payload 만 보낸다.
    const payload: ImageAttachment[] = images.map(({ name, mediaType, dataBase64 }) => ({
      name,
      mediaType,
      dataBase64
    }))
    // 실행 중이면 백엔드로 바로 보내지 않고 대기 큐에 넣는다 — 칩으로 표시되고 취소할 수 있으며,
    // 현재 턴이 끝나면(idle) 순서대로 자동 전송된다. 실행 중이 아니면 즉시 전송.
    setPickerCard(null)
    if (running) enqueueMessage(workspace.id, trimmed, payload.length ? payload : undefined)
    else void window.api.chat.send(workspace.id, trimmed, payload.length ? payload : undefined)
    setText('')
    setImages([])
    historyIdx.current = -1
  }

  /** 인터랙티브 명령을 실행하고 결과를 카드로 띄운다(사이드 답변 카드는 비켜 준다). */
  const runInteractive = (cmd: (typeof INTERACTIVE_COMMANDS)[number]): void => {
    setSideAnswer(null)
    setPickerCard(null)
    const seq = ++cmdSeq.current
    setCommandCard({ kind: cmd.kind, title: `/${cmd.name}`, status: 'loading' })
    void window.api.commands.run(workspace.id, cmd.kind).then(({ result, error }) => {
      // 이 카드를 띄운 요청이 아직 최신일 때만 반영(워크스페이스/명령 전환 후 도착한 응답은 버린다).
      if (cmdSeq.current !== seq) return
      setCommandCard((prev) => {
        if (!prev || prev.kind !== cmd.kind) return prev
        if (error || !result)
          return { ...prev, status: 'error', error: error || 'No data returned.' }
        return { ...prev, status: 'done', result }
      })
    })
  }

  /** /clear — 확인 후 대화 기록·세션을 초기화한다(백엔드 + 화면 모두). */
  const doClear = async (): Promise<void> => {
    const ok = await confirm({
      title: 'Clear this conversation?',
      body: 'Clears the transcript and starts a fresh session with empty context. This cannot be undone.',
      confirmLabel: 'Clear',
      danger: true
    })
    if (!ok) return
    await window.api.chat.clear(workspace.id)
    resetTranscript(workspace.id)
    pushToast('success', 'Started a fresh session.')
  }

  /**
   * Ditto UI 에서 직접 처리하는 로컬 명령(/diff·/copy·/help·/clear·/memory). 에이전트로
   * 보내지 않고 앱 기능으로 매핑한다. 입력창 텍스트 정리도 여기서 한다(대부분 비우고, /help 만
   * 자동완성 메뉴를 다시 띄우도록 '/' 를 남긴다).
   */
  const runLocal = (kind: LocalCommand): void => {
    setSideAnswer(null)
    setCommandCard(null)
    setPickerCard(null)

    if (kind === 'help') {
      setText('/') // 자동완성 메뉴로 사용 가능한 명령을 모두 보여 준다.
      taRef.current?.focus()
      return
    }

    setText('')
    if (kind === 'diff') {
      // ChatView 가 가진 diff 모달을 연다(Composer 에서 직접 접근할 수 없어 이벤트로 신호한다).
      window.dispatchEvent(new CustomEvent('ditto:open-diff', { detail: workspace.id }))
      return
    }
    if (kind === 'copy') {
      const last = [...items]
        .reverse()
        .find(
          (i): i is Extract<ChatItem, { type: 'assistant' }> =>
            i.type === 'assistant' && !!i.text?.trim()
        )
      if (!last) {
        pushToast('info', 'No assistant response to copy yet.')
        return
      }
      void navigator.clipboard.writeText(last.text).then(
        () => pushToast('success', 'Copied the last response to the clipboard.'),
        () => pushToast('error', 'Could not copy to the clipboard.')
      )
      return
    }
    if (kind === 'memory') {
      void window.api.workspace.openMemory(workspace.id).then((r) => {
        if (r.error) pushToast('error', r.error)
      })
      return
    }
    if (kind === 'clear') {
      void doClear()
    }
  }

  /** 선택한 슬래시 명령을 입력창에 채운다(인자를 이어 쓸 수 있도록 공백을 붙이고 포커스 유지). */
  const acceptCommand = (cmd: SlashCommandInfo): void => {
    setText(`/${cmd.name} `)
    historyIdx.current = -1
    taRef.current?.focus()
  }

  const userMessages = (): string[] =>
    items
      .filter((i): i is Extract<ChatItem, { type: 'user' }> => i.type === 'user')
      .map((i) => i.text)

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    // 슬래시 메뉴가 열려 있으면 방향키/Enter/Tab 을 메뉴 조작에 먼저 쓴다.
    if (menuOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        if (matches.length) setMenuIdx((i) => (i + 1) % matches.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        if (matches.length) setMenuIdx((i) => (i - 1 + matches.length) % matches.length)
        return
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        // 명령 입력을 비워 메뉴를 닫는다.
        setText('')
        return
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.nativeEvent.isComposing) {
        const cmd = matches[menuIdx]
        if (cmd) {
          e.preventDefault()
          acceptCommand(cmd)
          return
        }
      }
    }

    // 카드 Esc 닫기는 window 리스너(위 useEffect)가 포커스와 무관하게 처리한다.

    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
      return
    }
    // 입력창이 비었거나 history 탐색 중일 때 ↑/↓ 로 이전 사용자 메시지 순회.
    if (e.key === 'ArrowUp' && (text === '' || historyIdx.current >= 0)) {
      const msgs = userMessages()
      if (!msgs.length) return
      e.preventDefault()
      const next = historyIdx.current < 0 ? msgs.length - 1 : Math.max(0, historyIdx.current - 1)
      historyIdx.current = next
      setText(msgs[next])
    } else if (e.key === 'ArrowDown' && historyIdx.current >= 0) {
      const msgs = userMessages()
      e.preventDefault()
      const next = historyIdx.current + 1
      if (next >= msgs.length) {
        historyIdx.current = -1
        setText('')
      } else {
        historyIdx.current = next
        setText(msgs[next])
      }
    }
  }

  return (
    <div className="shrink-0 px-4 py-3 border-t border-[var(--border)]">
      <div className="max-w-3xl mx-auto relative">
        {menuOpen && (
          <SlashMenu
            matches={matches}
            loading={loadingCommands && matches.length === 0}
            selectedIdx={menuIdx}
            onHover={setMenuIdx}
            onPick={acceptCommand}
          />
        )}
        {commandCard && !menuOpen && !pickerCard && (
          <CommandCard
            card={commandCard}
            workspaceId={workspace.id}
            onResult={(result) => setCommandCard((prev) => (prev ? { ...prev, result } : prev))}
            onClose={() => setCommandCard(null)}
          />
        )}
        {sideAnswer && !menuOpen && !commandCard && !pickerCard && (
          <SideAnswerCard answer={sideAnswer} onClose={() => setSideAnswer(null)} />
        )}
        {pickerCard && !menuOpen && (
          <PickerCard
            kind={pickerCard}
            workspace={workspace}
            running={running}
            onClose={() => {
              setPickerCard(null)
              taRef.current?.focus()
            }}
          />
        )}
        {/* 입력창 위 상태줄: 브랜치 · 디렉토리 · 모델 · effort · 컨텍스트 사용량(항상 노출). */}
        <StatusLine workspace={workspace} onPick={openPicker} />
        {queue.length > 0 && (
          <div className="mb-2 space-y-1">
            {queue.map((m, i) => (
              <div
                key={i}
                className="flex items-center gap-2 bg-[var(--warning-500)]/5 border border-[var(--warning-500)]/20 rounded-lg pl-2.5 pr-1.5 py-1.5"
              >
                <Clock size={12} className="text-[var(--warning-400)]/80 shrink-0" />
                <span className="flex-1 min-w-0 truncate text-sm text-neutral-300" title={m.text}>
                  {m.text || (m.images?.length ? `${m.images.length} image(s)` : '')}
                </span>
                {m.images && m.images.length > 0 && (
                  <span className="text-xs text-neutral-600 shrink-0">📎{m.images.length}</span>
                )}
                <span className="text-xs text-neutral-600 shrink-0">queued</span>
                <button
                  onClick={() => removeQueued(workspace.id, i)}
                  title="Cancel this queued message"
                  className="shrink-0 h-5 w-5 grid place-items-center rounded text-neutral-500 hover:bg-[var(--surface-2)] hover:text-neutral-200"
                >
                  <X size={12} />
                </button>
              </div>
            ))}
          </div>
        )}
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-xl px-3 py-2 transition-shadow focus-within:border-[var(--border-strong)] focus-within:shadow-[0_0_0_3px_color-mix(in_srgb,var(--focus-ring)_12%,transparent)]">
          {images.length > 0 && (
            <div className="flex flex-wrap gap-2 mb-2">
              {images.map((img) => (
                <ImageChip key={img.id} img={img} onRemove={() => removeImage(img.id)} />
              ))}
            </div>
          )}
          <div className="flex items-end gap-2">
            <textarea
              ref={taRef}
              value={text}
              onChange={(e) => {
                setText(e.target.value)
                historyIdx.current = -1
              }}
              onKeyDown={onKeyDown}
              onPaste={onPaste}
              rows={1}
              placeholder={
                running
                  ? 'Queue a follow-up…  (Enter to send · it runs after the current turn)'
                  : 'Message your agent…  (Enter to send · / for commands · ! to run a terminal command)'
              }
              className="flex-1 bg-transparent resize-none outline-none text-base leading-relaxed text-neutral-200 placeholder:text-neutral-600 py-1"
            />
            {running && (
              <button
                onClick={() => void window.api.chat.interrupt(workspace.id)}
                title="Stop the current turn"
                className="h-8 w-8 grid place-items-center rounded-lg bg-[var(--danger-500)]/15 text-[var(--danger-400)] hover:bg-[var(--danger-500)]/25 active:scale-95"
              >
                <Square size={15} fill="currentColor" />
              </button>
            )}
            <button
              onClick={send}
              disabled={!text.trim() && images.length === 0}
              title={bashMode ? 'Run in terminal' : running ? 'Queue message' : 'Send'}
              className={
                'h-8 w-8 grid place-items-center rounded-lg text-white shadow-sm active:scale-95 disabled:bg-[var(--border)] disabled:text-neutral-600 disabled:shadow-none disabled:cursor-not-allowed ' +
                (bashMode
                  ? 'bg-[var(--success-600)] hover:bg-[var(--success-500)]'
                  : 'bg-[var(--info-600)] hover:bg-[var(--info-500)]')
              }
            >
              {bashMode ? <TerminalIcon size={15} /> : <Send size={15} />}
            </button>
          </div>
        </div>
      </div>
      <div className="max-w-3xl mx-auto mt-1.5 px-1 text-xs flex items-center gap-3">
        <div className="min-w-0 flex-1">
          {bashMode ? (
            <span className="text-[var(--success-400)] inline-flex items-center gap-1">
              <TerminalIcon size={11} />
              Run command{' '}
              <span className="text-neutral-600">
                (Enter to run · output shows here in the chat)
              </span>
            </span>
          ) : (
            (() => {
              const footer = PERMISSION_FOOTER[workspace.permissionMode]
              const accent =
                workspace.permissionMode === 'plan' ? 'text-cyan-400' : 'text-[var(--warning-400)]'
              return footer ? (
                <span className={accent}>
                  {footer.symbol} {footer.text}{' '}
                  <span className="text-neutral-600">(shift+tab to cycle)</span>
                </span>
              ) : (
                <span className="text-neutral-600">shift+tab to cycle permission modes</span>
              )
            })()
          )}
        </div>
      </div>
    </div>
  )
}

/** 전송 대기 중인 붙여넣기 이미지 칩(썸네일 + 이름 + 제거). */
function ImageChip({
  img,
  onRemove
}: {
  img: PendingImage
  onRemove: () => void
}): React.JSX.Element {
  return (
    <div className="group/chip relative flex items-center gap-1.5 pl-1 pr-2 py-1 rounded-lg bg-[var(--surface-3)] border border-[var(--border)]">
      <img src={img.previewUrl} alt={img.name} className="h-7 w-7 rounded object-cover" />
      <ImageIcon size={11} className="text-neutral-500 shrink-0" />
      <span className="text-xs text-neutral-300 max-w-[140px] truncate">{img.name}</span>
      <button
        onClick={onRemove}
        title="Remove image"
        className="ml-0.5 shrink-0 h-4 w-4 grid place-items-center rounded text-neutral-500 hover:text-neutral-200 hover:bg-[var(--surface-4)]"
      >
        <X size={12} />
      </button>
    </div>
  )
}

/** 입력창 위에 뜨는 슬래시 명령 자동완성 목록(Claude Code 스타일). */
function SlashMenu({
  matches,
  loading,
  selectedIdx,
  onHover,
  onPick
}: {
  matches: SlashCommandInfo[]
  loading: boolean
  selectedIdx: number
  onHover: (idx: number) => void
  onPick: (cmd: SlashCommandInfo) => void
}): React.JSX.Element {
  const activeRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedIdx])
  return (
    <div className="absolute bottom-full mb-2 left-0 right-0 max-h-72 overflow-y-auto rounded-xl border border-[var(--border)] bg-[var(--bg-3)] shadow-2xl py-1 z-20">
      {loading ? (
        <div className="px-3 py-2 text-sm text-neutral-500">Loading commands…</div>
      ) : (
        matches.map((cmd, i) => {
          const active = i === selectedIdx
          return (
            <button
              key={cmd.name}
              ref={(el) => {
                if (active) activeRef.current = el
              }}
              onMouseEnter={() => onHover(i)}
              onMouseDown={(e) => {
                // textarea 가 blur 되지 않도록 기본 동작을 막고 직접 처리.
                e.preventDefault()
                onPick(cmd)
              }}
              className={
                'w-full flex items-baseline gap-2 px-3 py-1.5 text-left ' +
                (active ? 'bg-[var(--surface-3)]' : 'hover:bg-[var(--surface)]')
              }
            >
              <TerminalIcon
                size={12}
                className="text-[var(--accent-400)] shrink-0 translate-y-0.5"
              />
              <span className="text-sm font-medium text-neutral-100 shrink-0">/{cmd.name}</span>
              {cmd.argumentHint && (
                <span className="text-xs text-neutral-500 shrink-0">{cmd.argumentHint}</span>
              )}
              {cmd.description && (
                <span className="text-xs text-neutral-500 truncate">{cmd.description}</span>
              )}
            </button>
          )
        })
      )}
    </div>
  )
}

/** /btw 사이드 답변의 임시 상태(트랜스크립트에 저장되지 않음). */
type SideAnswer = {
  id: string
  question: string
  text: string
  status: 'streaming' | 'done' | 'error'
  error?: string
}

/**
 * 입력창 위에 뜨는 /btw 사이드 답변 카드.
 * 메인 대화와 분리된 임시 표시 — 닫으면(Esc/✕) 사라지고 기록에 남지 않는다.
 */
function SideAnswerCard({
  answer,
  onClose
}: {
  answer: SideAnswer
  onClose: () => void
}): React.JSX.Element {
  return (
    <div className="absolute bottom-full mb-2 left-0 right-0 max-h-80 overflow-y-auto rounded-xl border border-[var(--accent-500)]/30 bg-[var(--bg-3)] shadow-2xl z-20">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)] sticky top-0 bg-[var(--bg-3)]">
        <MessageCircleQuestion size={13} className="text-[var(--accent-400)] shrink-0" />
        <span className="text-xs font-medium text-[var(--accent-300)] shrink-0">Side question</span>
        <span className="text-xs text-neutral-500 truncate">{answer.question}</span>
        <span className="ml-auto shrink-0 text-xs text-neutral-600 select-none">Esc to close</span>
        <button
          onClick={onClose}
          title="Dismiss (Esc)"
          className="shrink-0 h-5 w-5 grid place-items-center rounded text-neutral-500 hover:text-neutral-200 hover:bg-[var(--surface-3)]"
        >
          <X size={13} />
        </button>
      </div>
      <div className="px-3 py-2 text-sm leading-relaxed text-neutral-200 whitespace-pre-wrap">
        {answer.status === 'error' ? (
          <span className="text-[var(--danger-400)]">
            {answer.error || 'Side question failed.'}
          </span>
        ) : (
          <>
            {answer.text}
            {answer.status === 'streaming' && (
              <span className="text-neutral-500">{answer.text ? ' ▍' : 'Thinking…'}</span>
            )}
          </>
        )}
      </div>
    </div>
  )
}

/** "/model"·"/effort" 면 그 종류를 돌려준다(뒤따르는 인자는 무시하고 선택 카드를 연다). */
function matchPicker(text: string): 'model' | 'effort' | null {
  const m = /^\/(model|effort)(?:\s.*)?$/.exec(text)
  return m ? (m[1] as 'model' | 'effort') : null
}

/**
 * "/mcp" 처럼 인자 없는 인터랙티브 명령이면 해당 정의를 돌려준다(아니면 null).
 * 별칭도 함께 해석한다(예: /cost·/stats → /usage).
 */
function matchInteractive(text: string): (typeof INTERACTIVE_COMMANDS)[number] | null {
  const m = /^\/([\w-]+)\s*$/.exec(text)
  if (!m) return null
  const name = m[1]
  return INTERACTIVE_COMMANDS.find((c) => c.name === name || c.aliases?.includes(name)) ?? null
}

/** Ditto UI 가 직접 처리하는 로컬 명령(에이전트로 보내지 않음). */
type LocalCommand = 'diff' | 'copy' | 'help' | 'clear' | 'memory'
const LOCAL_COMMANDS: readonly LocalCommand[] = ['diff', 'copy', 'help', 'clear', 'memory']

/** "/diff" 처럼 로컬에서 처리하는 명령이면 그 종류를 돌려준다(뒤따르는 인자는 무시). */
function matchLocal(text: string): LocalCommand | null {
  const m = /^\/([\w-]+)(?:\s[\s\S]*)?$/.exec(text)
  if (!m) return null
  return (LOCAL_COMMANDS as readonly string[]).includes(m[1]) ? (m[1] as LocalCommand) : null
}

/** 인터랙티브 명령 결과 카드의 임시 상태(트랜스크립트에 저장되지 않음). */
type CommandCardState = {
  kind: CommandPanelKind
  title: string
  status: 'loading' | 'done' | 'error'
  result?: CommandResult
  error?: string
}

const CARD_ICON: Record<CommandPanelKind, React.ReactNode> = {
  mcp: <Plug size={13} className="text-[var(--accent-400)] shrink-0" />,
  context: <Gauge size={13} className="text-[var(--accent-400)] shrink-0" />,
  usage: <Receipt size={13} className="text-[var(--accent-400)] shrink-0" />,
  agents: <Bot size={13} className="text-[var(--accent-400)] shrink-0" />,
  reloadPlugins: <RefreshCw size={13} className="text-[var(--accent-400)] shrink-0" />,
  reloadSkills: <RefreshCw size={13} className="text-[var(--accent-400)] shrink-0" />,
  rewind: <History size={13} className="text-[var(--accent-400)] shrink-0" />,
  permissions: <ShieldCheck size={13} className="text-[var(--accent-400)] shrink-0" />
}

/** 토큰 수를 1.2k 형태로 간결하게 표기. */
function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`
}

const MCP_STATUS_COLOR: Record<string, string> = {
  connected: 'bg-[var(--success-400)]',
  failed: 'bg-[var(--danger-400)]',
  'needs-auth': 'bg-[var(--warning-400)]',
  pending: 'bg-neutral-400',
  disabled: 'bg-neutral-600'
}

const MCP_STATUS_LABEL: Record<McpServerInfo['status'], string> = {
  connected: 'connected',
  failed: 'failed',
  'needs-auth': 'needs auth',
  pending: 'connecting…',
  disabled: 'disabled'
}

/** 상세 보기에서 서버 상태별로 가능한 동작 순서(키보드 커서 인덱스의 기준). */
function mcpActionsFor(server: McpServerInfo): McpAction[] {
  return server.status === 'disabled' ? ['enable'] : ['reconnect', 'disable']
}

/** 동작 메뉴 항목의 아이콘·라벨. */
const MCP_ACTION_META: Record<McpAction, { icon: React.ReactNode; label: string }> = {
  reconnect: { icon: <RotateCw size={12} />, label: 'Reconnect' },
  enable: { icon: <Power size={12} />, label: 'Enable' },
  disable: { icon: <PowerOff size={12} />, label: 'Disable' }
}

/** 키보드로 가로채는 내비게이션 키(나머지 입력은 textarea 로 그대로 흘려보낸다). */
const MCP_NAV_KEYS = ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Enter', 'Escape']

/**
 * /mcp 패널. Claude Code CLI 의 /mcp 처럼 단순 목록이 아니라, 서버를 골라 들어가 재연결·
 * 활성/비활성을 할 수 있는 인터랙티브 뷰다. 동작은 main 의 살아 있는 세션 제어 채널에서
 * 일어나며(필요하면 세션을 warm up), 적용 후 갱신된 목록을 onResult 로 카드에 되돌린다.
 *
 * 카드는 입력창(textarea) 위에 떠 있고 포커스는 textarea 에 남으므로, 방향키/Enter 를
 * document 캡처 단계에서 가로채 처리한다 — 가로챈 키는 stopPropagation 으로 textarea(=히스토리
 * 탐색·전송)까지 가지 않게 막고, 그 외 키는 건드리지 않아 평소처럼 입력된다. 목록에서의 Esc 만은
 * 가로채지 않고 흘려보내 Composer 가 카드를 닫게 둔다.
 */
function McpPanel({
  servers,
  workspaceId,
  onResult
}: {
  servers: McpServerInfo[]
  workspaceId: string
  onResult: (result: CommandResult) => void
}): React.JSX.Element {
  const [selected, setSelected] = useState<string | null>(null)
  const [busy, setBusy] = useState<McpAction | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [listCursor, setListCursor] = useState(0)
  const [actionCursor, setActionCursor] = useState(0)
  // 키보드 커서가 가리키는 항목(스크롤 추적용).
  const activeRef = useRef<HTMLElement | null>(null)

  const current = selected ? (servers.find((s) => s.name === selected) ?? null) : null

  const open = (name: string): void => {
    setSelected(name)
    setActionCursor(0)
    setError(null)
  }
  const back = (): void => {
    setSelected(null)
    setError(null)
  }
  const runAction = (action: McpAction, name: string): void => {
    setBusy(action)
    setError(null)
    void window.api.commands.mcpAction(workspaceId, name, action).then((res) => {
      setBusy(null)
      if (res.error || !res.servers) {
        setError(res.error || 'Action failed.')
        return
      }
      onResult({ kind: 'mcp', servers: res.servers })
    })
  }

  // 최신 상태를 보는 키 핸들러를 매 렌더 갱신하고, 리스너는 한 번만 바인딩한다(stale closure 방지).
  const handlerRef = useRef<(e: KeyboardEvent) => void>(() => {})
  handlerRef.current = (e: KeyboardEvent): void => {
    if (!servers.length || !MCP_NAV_KEYS.includes(e.key)) return
    const stop = (): void => {
      e.preventDefault()
      e.stopPropagation()
    }

    // 상세 보기: ↑/↓ 로 동작(+뒤로) 이동, Enter 실행, Esc/← 로 뒤로.
    if (current) {
      if (e.key === 'Escape' || e.key === 'ArrowLeft') {
        stop()
        back()
        return
      }
      stop() // 그 외 내비 키는 진행 중이어도 textarea 로 새지 않게 가둔다.
      if (busy) return
      const acts = mcpActionsFor(current)
      const count = acts.length + 1 // +뒤로
      if (e.key === 'ArrowDown') setActionCursor((c) => (c + 1) % count)
      else if (e.key === 'ArrowUp') setActionCursor((c) => (c - 1 + count) % count)
      else if (e.key === 'Enter') {
        if (actionCursor >= acts.length) back()
        else runAction(acts[actionCursor], current.name)
      }
      return
    }

    // 목록 보기: Esc 는 카드 닫기(Composer)에 맡기고, 나머지는 가로채 이동/진입한다.
    if (e.key === 'Escape') return
    stop()
    if (e.key === 'ArrowDown') setListCursor((c) => (c + 1) % servers.length)
    else if (e.key === 'ArrowUp') setListCursor((c) => (c - 1 + servers.length) % servers.length)
    else if (e.key === 'Enter' || e.key === 'ArrowRight') {
      const s = servers[Math.min(listCursor, servers.length - 1)]
      if (s) open(s.name)
    }
  }

  useEffect(() => {
    const listener = (e: KeyboardEvent): void => handlerRef.current(e)
    document.addEventListener('keydown', listener, true)
    return () => document.removeEventListener('keydown', listener, true)
  }, [])

  // 커서가 가리키는 항목을 화면 안으로 스크롤.
  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [listCursor, actionCursor, selected])

  if (servers.length === 0) return <Empty>No MCP servers configured.</Empty>

  if (current) {
    return (
      <McpServerDetail
        server={current}
        busy={busy}
        error={error}
        cursor={actionCursor}
        activeRef={activeRef}
        onHover={setActionCursor}
        onActivate={(i) => {
          const acts = mcpActionsFor(current)
          if (i >= acts.length) back()
          else runAction(acts[i], current.name)
        }}
      />
    )
  }

  const cursor = Math.min(listCursor, servers.length - 1)
  return (
    <div className="space-y-1.5">
      <ul className="space-y-0.5">
        {servers.map((s, i) => {
          const active = i === cursor
          return (
            <li key={s.name}>
              <button
                ref={(el) => {
                  if (active) activeRef.current = el
                }}
                onMouseEnter={() => setListCursor(i)}
                onClick={() => open(s.name)}
                className={`w-full flex items-center gap-2 text-left rounded-md px-1.5 py-1 transition-colors ${active ? 'bg-[var(--surface-3)]' : 'hover:bg-[var(--surface-3)]'}`}
              >
                <span
                  className={`h-2 w-2 rounded-full shrink-0 ${MCP_STATUS_COLOR[s.status] ?? 'bg-neutral-500'}`}
                  title={MCP_STATUS_LABEL[s.status]}
                />
                <span className="font-medium text-neutral-100 truncate">{s.name}</span>
                <span className="text-xs text-neutral-500 shrink-0">
                  {MCP_STATUS_LABEL[s.status]}
                </span>
                {s.scope && <span className="text-xs text-neutral-600 shrink-0">· {s.scope}</span>}
                {typeof s.toolCount === 'number' && (
                  <span className="text-xs text-neutral-500 ml-auto shrink-0">
                    {s.toolCount} {s.toolCount === 1 ? 'tool' : 'tools'}
                  </span>
                )}
                <ChevronRight
                  size={13}
                  className={`text-neutral-600 shrink-0 ${typeof s.toolCount === 'number' ? '' : 'ml-auto'}`}
                />
              </button>
            </li>
          )
        })}
      </ul>
      <McpHint text="↑↓ navigate · ↵ open · esc close" />
    </div>
  )
}

/** /mcp 서버 1개의 상세 + 동작(재연결·활성/비활성) 메뉴 뷰. */
function McpServerDetail({
  server,
  busy,
  error,
  cursor,
  activeRef,
  onHover,
  onActivate
}: {
  server: McpServerInfo
  busy: McpAction | null
  error: string | null
  /** 키보드 커서 인덱스(0..actions.length, 마지막은 '뒤로'). */
  cursor: number
  activeRef: React.MutableRefObject<HTMLElement | null>
  onHover: (index: number) => void
  onActivate: (index: number) => void
}): React.JSX.Element {
  const actions = mcpActionsFor(server)
  const items = actions.length // '뒤로' 항목 인덱스

  return (
    <div className="space-y-2.5">
      <div className="space-y-1">
        <div className="flex items-center gap-2">
          <span
            className={`h-2 w-2 rounded-full shrink-0 ${MCP_STATUS_COLOR[server.status] ?? 'bg-neutral-500'}`}
          />
          <span className="font-medium text-neutral-100 truncate">{server.name}</span>
          <span className="text-xs text-neutral-500 shrink-0">
            {MCP_STATUS_LABEL[server.status]}
          </span>
          {server.version && (
            <span className="text-xs text-neutral-600 shrink-0">v{server.version}</span>
          )}
        </div>
        <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-xs text-neutral-500">
          {server.scope && <span>scope: {server.scope}</span>}
          {server.transport && <span>transport: {server.transport}</span>}
          {typeof server.toolCount === 'number' && (
            <span>
              {server.toolCount} {server.toolCount === 1 ? 'tool' : 'tools'}
            </span>
          )}
        </div>
        {server.endpoint && (
          <div className="text-xs text-neutral-600 break-all" title={server.endpoint}>
            {server.endpoint}
          </div>
        )}
      </div>

      {server.error && (
        <div className="text-xs text-[var(--danger-400)] break-words rounded-md bg-[var(--danger-500)]/10 px-2 py-1.5">
          {server.error}
        </div>
      )}

      {server.status === 'needs-auth' && (
        <div className="text-xs text-[var(--warning-400)]">
          Authentication required — reconnect to start the auth flow.
        </div>
      )}

      {/* 동작 메뉴: CLI /mcp 와 동일하게 재연결 + 활성/비활성 + 뒤로. 키보드/마우스 모두 가능. */}
      <div className="space-y-0.5">
        {actions.map((action, i) => {
          const active = i === cursor
          const loading = busy === action
          return (
            <button
              key={action}
              ref={(el) => {
                if (active) activeRef.current = el
              }}
              onMouseEnter={() => onHover(i)}
              onClick={() => onActivate(i)}
              disabled={busy !== null}
              className={`w-full flex items-center gap-1.5 text-left rounded-md px-2 py-1 text-xs transition-colors disabled:opacity-50 disabled:cursor-default ${active ? 'bg-[var(--surface-3)] text-neutral-100' : 'text-neutral-300 hover:bg-[var(--surface-3)]'}`}
            >
              {loading ? (
                <Loader2 size={12} className="animate-spin" />
              ) : (
                MCP_ACTION_META[action].icon
              )}
              {MCP_ACTION_META[action].label}
            </button>
          )
        })}
        <button
          ref={(el) => {
            if (cursor === items) activeRef.current = el
          }}
          onMouseEnter={() => onHover(items)}
          onClick={() => onActivate(items)}
          className={`w-full flex items-center gap-1.5 text-left rounded-md px-2 py-1 text-xs transition-colors ${cursor === items ? 'bg-[var(--surface-3)] text-neutral-100' : 'text-neutral-400 hover:bg-[var(--surface-3)]'}`}
        >
          <ArrowLeft size={12} /> Back to all servers
        </button>
      </div>

      {error && <div className="text-xs text-[var(--danger-400)]">{error}</div>}

      {server.tools && server.tools.length > 0 && (
        <div className="space-y-1 pt-1 border-t border-[var(--border)]">
          <div className="text-xs text-neutral-500 pt-1.5">Tools</div>
          <ul className="space-y-0.5">
            {server.tools.map((t) => (
              <li key={t.name} className="text-xs">
                <span className="text-neutral-200">{t.name}</span>
                {t.description && (
                  <span className="text-neutral-600 truncate"> — {t.description}</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      <McpHint text="↑↓ navigate · ↵ select · esc/← back" />
    </div>
  )
}

/** /mcp 패널 하단의 키보드 조작 힌트. */
function McpHint({ text }: { text: string }): React.JSX.Element {
  return <div className="text-xs text-neutral-600 pt-0.5">{text}</div>
}

/**
 * 입력창 위에 뜨는 인터랙티브 명령 결과 카드(/mcp·/context 등).
 * /btw 카드와 같은 임시 표시 — 닫으면(Esc/✕) 사라지고 기록에 남지 않는다.
 */
function CommandCard({
  card,
  workspaceId,
  onResult,
  onClose
}: {
  card: CommandCardState
  workspaceId: string
  /** mcp 패널의 서버 동작 후 갱신된 결과를 카드에 반영하기 위한 콜백. */
  onResult: (result: CommandResult) => void
  onClose: () => void
}): React.JSX.Element {
  return (
    <div className="absolute bottom-full mb-2 left-0 right-0 max-h-96 overflow-y-auto rounded-xl border border-[var(--accent-500)]/30 bg-[var(--bg-3)] shadow-2xl z-20">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)] sticky top-0 bg-[var(--bg-3)]">
        {CARD_ICON[card.kind]}
        <span className="text-sm font-medium text-[var(--accent-300)] shrink-0">{card.title}</span>
        {card.status === 'loading' && (
          <Loader2 size={12} className="text-neutral-500 animate-spin" />
        )}
        <span className="ml-auto shrink-0 text-xs text-neutral-600 select-none">Esc to close</span>
        <button
          onClick={onClose}
          title="Dismiss (Esc)"
          className="shrink-0 h-5 w-5 grid place-items-center rounded text-neutral-500 hover:text-neutral-200 hover:bg-[var(--surface-3)]"
        >
          <X size={13} />
        </button>
      </div>
      <div className="px-3 py-2.5 text-sm leading-relaxed text-neutral-200">
        {card.status === 'loading' ? (
          <span className="text-neutral-500">Loading…</span>
        ) : card.status === 'error' ? (
          <span className="text-[var(--danger-400)]">{card.error || 'Command failed.'}</span>
        ) : (
          card.result && (
            <CommandResultView result={card.result} workspaceId={workspaceId} onResult={onResult} />
          )
        )}
      </div>
    </div>
  )
}

/** CommandResult 종류별 본문 렌더링. */
function CommandResultView({
  result,
  workspaceId,
  onResult
}: {
  result: CommandResult
  workspaceId: string
  onResult: (result: CommandResult) => void
}): React.JSX.Element {
  switch (result.kind) {
    case 'mcp':
      return <McpPanel servers={result.servers} workspaceId={workspaceId} onResult={onResult} />

    case 'agents':
      return result.agents.length === 0 ? (
        <Empty>No subagents available.</Empty>
      ) : (
        <ul className="space-y-1.5">
          {result.agents.map((a) => (
            <li key={a.name}>
              <div className="flex items-baseline gap-2">
                <span className="font-medium text-neutral-100">{a.name}</span>
                {a.model && <span className="text-xs text-neutral-500">{a.model}</span>}
              </div>
              <div className="text-xs text-neutral-500 leading-snug">{a.description}</div>
            </li>
          ))}
        </ul>
      )

    case 'context': {
      const c = result.context
      return (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <div className="flex-1 h-2 rounded-full bg-[var(--surface-3)] overflow-hidden">
              <div
                className="h-full bg-[var(--accent-400)]"
                style={{ width: `${Math.min(100, Math.round(c.percentage))}%` }}
              />
            </div>
            <span className="text-xs text-neutral-400 shrink-0">
              {fmtTokens(c.totalTokens)} / {fmtTokens(c.maxTokens)} ({Math.round(c.percentage)}%)
            </span>
          </div>
          <div className="text-xs text-neutral-600">{c.model}</div>
          <ul className="space-y-1">
            {c.categories.slice(0, 8).map((cat) => (
              <li key={cat.name} className="flex items-center justify-between gap-2">
                <span className="text-neutral-300 truncate">{cat.name}</span>
                <span className="text-xs text-neutral-500 shrink-0">{fmtTokens(cat.tokens)}</span>
              </li>
            ))}
          </ul>
        </div>
      )
    }

    case 'usage': {
      const u = result.usage
      return (
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-neutral-400">Session cost</span>
            <span className="font-medium text-neutral-100">${u.totalCostUsd.toFixed(4)}</span>
          </div>
          <div className="flex items-center justify-between text-xs">
            <span className="text-neutral-500">Lines changed</span>
            <span className="text-neutral-400">
              <span className="text-[var(--success-400)]">+{u.linesAdded}</span>{' '}
              <span className="text-[var(--danger-400)]">−{u.linesRemoved}</span>
            </span>
          </div>
          {u.subscriptionType && (
            <div className="flex items-center justify-between text-xs">
              <span className="text-neutral-500">Plan</span>
              <span className="text-neutral-400 capitalize">{u.subscriptionType}</span>
            </div>
          )}
          {u.rateLimitsAvailable && u.rateLimits.length > 0 && (
            <div className="space-y-1 pt-1 border-t border-[var(--border)]">
              {u.rateLimits.map((r) => (
                <div key={r.label} className="flex items-center gap-2">
                  <span className="text-xs text-neutral-500 w-24 shrink-0">{r.label}</span>
                  <div className="flex-1 h-1.5 rounded-full bg-[var(--surface-3)] overflow-hidden">
                    <div
                      className="h-full bg-[var(--accent-400)]"
                      style={{ width: `${Math.min(100, Math.round(r.utilization ?? 0))}%` }}
                    />
                  </div>
                  <span className="text-xs text-neutral-500 shrink-0">
                    {r.utilization == null ? '—' : `${Math.round(r.utilization)}%`}
                  </span>
                </div>
              ))}
            </div>
          )}
          {!u.rateLimitsAvailable && (
            <div className="text-xs text-neutral-600 pt-1">
              Plan rate limits not available for this session.
            </div>
          )}
        </div>
      )
    }

    case 'reloadPlugins': {
      const r = result.reload
      const parts = [
        `${r.pluginCount ?? 0} plugins`,
        `${r.commandCount ?? 0} commands`,
        `${r.agentCount ?? 0} agents`,
        `${r.mcpServerCount ?? 0} MCP servers`
      ]
      return (
        <div className="space-y-1">
          <div className="text-[var(--success-400)]">Reloaded {parts.join(' · ')}.</div>
          {!!r.errorCount && (
            <div className="text-[var(--warning-500)]">{r.errorCount} error(s) during reload.</div>
          )}
        </div>
      )
    }

    case 'reloadSkills':
      return (
        <div className="text-[var(--success-400)]">
          Reloaded {result.reload.skillCount ?? 0} skills.
        </div>
      )

    case 'rewind':
      return <RewindPanel checkpoints={result.checkpoints} workspaceId={workspaceId} />

    case 'permissions':
      return <PermissionsPanel info={result.permissions} />
  }
}

/** 권한 모드별 한 줄 설명(상태줄·footer 와 같은 의미). */
const PERMISSION_MODE_LABEL: Record<string, string> = {
  default: 'Default — ask before edits and commands',
  acceptEdits: 'Accept edits — auto-approve file edits',
  plan: 'Plan — read-only, proposes a plan first',
  auto: 'Auto — run without asking (use with care)'
}

/**
 * /permissions — 현재 권한 모드와 설정 파일에서 모은 allow/ask/deny 규칙을 읽기 전용으로 보여 준다.
 * 모드 변경은 Claude Code 처럼 Shift+Tab 으로 순환한다(이 카드는 현황 표시 전용).
 */
function PermissionsPanel({ info }: { info: PermissionsInfo }): React.JSX.Element {
  const Section = ({
    title,
    rules,
    tone
  }: {
    title: string
    rules: string[]
    tone: string
  }): React.JSX.Element => (
    <div className="space-y-1">
      <div className="text-xs text-neutral-500">
        {title} <span className="text-neutral-600">({rules.length})</span>
      </div>
      {rules.length === 0 ? (
        <div className="text-xs text-neutral-600">—</div>
      ) : (
        <ul className="space-y-0.5">
          {rules.map((r) => (
            <li key={r} className={`text-xs font-mono ${tone}`}>
              {r}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
  return (
    <div className="space-y-2.5">
      <div className="space-y-0.5">
        <div className="text-neutral-200">{PERMISSION_MODE_LABEL[info.mode] ?? info.mode}</div>
        <div className="text-xs text-neutral-600">shift+tab to cycle the permission mode</div>
      </div>
      <div className="space-y-2 pt-1 border-t border-[var(--border)]">
        <Section title="Allow" rules={info.allow} tone="text-[var(--success-400)]" />
        <Section title="Ask" rules={info.ask} tone="text-[var(--warning-400)]" />
        <Section title="Deny" rules={info.deny} tone="text-[var(--danger-400)]" />
      </div>
      {info.sources.length > 0 ? (
        <div className="text-xs text-neutral-600 pt-1 border-t border-[var(--border)] break-all">
          From: {info.sources.join(' · ')}
        </div>
      ) : (
        <div className="text-xs text-neutral-600 pt-1 border-t border-[var(--border)]">
          No permission rules found in settings files.
        </div>
      )}
    </div>
  )
}

/**
 * /rewind — 파일 체크포인트(보낸 메시지 지점) 목록. 하나를 고르면 그 시점으로 추적된 파일을 되돌린다.
 * 체크포인트 백업은 살아 있는 세션 안에 있으므로, 같은 세션이 떠 있을 때만 동작한다 —
 * 비어 있거나 되돌릴 수 없으면 그 사정을 안내한다.
 */
function RewindPanel({
  checkpoints,
  workspaceId
}: {
  checkpoints: RewindPoint[]
  workspaceId: string
}): React.JSX.Element {
  const [busyId, setBusyId] = useState<string | null>(null)
  const [done, setDone] = useState<{ id: string; text: string; ok: boolean } | null>(null)
  const pushToast = useStore((s) => s.pushToast)

  if (checkpoints.length === 0) {
    return (
      <Empty>
        No checkpoints yet. Each message you send while this session is live becomes a restore
        point.
      </Empty>
    )
  }

  const restore = (cp: RewindPoint): void => {
    setBusyId(cp.userMessageId)
    setDone(null)
    void window.api.commands
      .rewindAction(workspaceId, cp.userMessageId)
      .then(({ result, error }) => {
        setBusyId(null)
        if (error || !result) {
          setDone({ id: cp.userMessageId, text: error || 'Rewind failed.', ok: false })
          return
        }
        if (!result.canRewind) {
          setDone({ id: cp.userMessageId, text: result.error || 'Nothing to restore.', ok: false })
          return
        }
        const n = result.filesChanged?.length ?? 0
        const detail =
          typeof result.insertions === 'number' || typeof result.deletions === 'number'
            ? ` (+${result.insertions ?? 0} −${result.deletions ?? 0})`
            : ''
        const summary = `Restored ${n} file${n === 1 ? '' : 's'}${detail}.`
        setDone({ id: cp.userMessageId, text: summary, ok: true })
        pushToast('success', summary)
      })
  }

  return (
    <div className="space-y-1.5">
      <div className="text-xs text-neutral-600">Restore tracked files to a message:</div>
      <ul className="space-y-0.5">
        {checkpoints.map((cp) => {
          const busy = busyId === cp.userMessageId
          const result = done?.id === cp.userMessageId ? done : null
          return (
            <li key={cp.userMessageId}>
              <button
                onClick={() => restore(cp)}
                disabled={busyId !== null}
                className="w-full flex items-center gap-2 text-left rounded-md px-1.5 py-1 transition-colors hover:bg-[var(--surface-3)] disabled:opacity-50 disabled:cursor-default"
              >
                {busy ? (
                  <Loader2 size={12} className="shrink-0 animate-spin text-neutral-500" />
                ) : (
                  <RotateCcw size={12} className="shrink-0 text-neutral-500" />
                )}
                <span className="flex-1 min-w-0 truncate text-sm text-neutral-200" title={cp.text}>
                  {cp.text}
                </span>
              </button>
              {result && (
                <div
                  className={`px-1.5 pb-1 text-xs ${result.ok ? 'text-[var(--success-400)]' : 'text-[var(--danger-400)]'}`}
                >
                  {result.text}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

function Empty({ children }: { children: React.ReactNode }): React.JSX.Element {
  return <span className="text-neutral-500">{children}</span>
}

/**
 * 입력창 바로 위에 항상 노출되는 상태줄.
 * 현재 브랜치 · worktree 디렉토리명 · 컨텍스트 사용량을 한 줄로 보여 준다(옵셔널/토글 없음).
 * 컨텍스트는 Claude Code CLI 의 컨텍스트 게이지에 대응 — 막대 + 퍼센트로 표시하고,
 * 자동 압축이 도는 동안에는 진행 표시로, 사용량 데이터가 아직 없으면(첫 턴 전) "—" 로 바뀐다.
 */
function StatusLine({
  workspace,
  onPick
}: {
  workspace: Workspace
  /** 모델/effort 항목 클릭 시 해당 선택 카드를 연다(슬래시 /model·/effort 와 동일). */
  onPick: (kind: 'model' | 'effort') => void
}): React.JSX.Element {
  const usage = useStore((s) => s.contextUsage[workspace.id])
  const compacting = useStore((s) => s.compacting[workspace.id] ?? false)
  const liveBranch = useStore((s) => s.gitStatus[workspace.id]?.branch)
  const settingsModel = useStore((s) => s.app!.settings.model)
  const settingsEffort = useStore((s) => s.app!.settings.effort)

  // worktree 절대 경로의 마지막 구간(디렉토리명). 비정상 경로면 전체 경로로 폴백한다.
  const dirName = workspace.worktreePath.split('/').filter(Boolean).pop() ?? workspace.worktreePath

  // 라이브 git 브랜치를 우선 표시한다. workspace.branch 는 생성 시점에 고정된 값이라
  // 세션 도중 브랜치명을 바꾸면 반영되지 못하므로, git status 로 읽은 현재 브랜치를
  // 사용한다. 아직 git 상태를 못 받았거나 불명('?')이면 저장된 branch 로 폴백한다.
  const branch = liveBranch && liveBranch !== '?' ? liveBranch : workspace.branch

  // 표시는 "유효 값" 기준: workspace 오버라이드 → (모델은 init 으로 확정된 lastModel) → 전역 설정.
  const modelText = modelLabel(workspace.model ?? workspace.lastModel ?? settingsModel)
  const effortText = effortLabel(workspace.effort ?? settingsEffort)

  return (
    <div className="flex items-center gap-3 mb-1.5 px-1 text-xs text-neutral-500">
      <span className="flex items-center gap-1 min-w-0 shrink" title={`Branch: ${branch}`}>
        <GitBranch size={11} className="shrink-0 text-neutral-600" />
        <span className="truncate">{branch}</span>
      </span>
      <span
        className="flex items-center gap-1 min-w-0 shrink"
        title={`Directory: ${workspace.worktreePath}`}
      >
        <Folder size={11} className="shrink-0 text-neutral-600" />
        <span className="truncate">{dirName}</span>
      </span>
      <button
        onClick={() => onPick('model')}
        className="flex items-center gap-1 min-w-0 shrink hover:text-neutral-300 transition-colors"
        title={`Model: ${modelText} — click or type /model to change`}
      >
        <Cpu size={11} className="shrink-0 text-neutral-600" />
        <span className="truncate">{modelText}</span>
      </button>
      <button
        onClick={() => onPick('effort')}
        className="flex items-center gap-1 min-w-0 shrink hover:text-neutral-300 transition-colors"
        title={`Reasoning effort: ${effortText} — click or type /effort to change`}
      >
        <Zap size={11} className="shrink-0 text-neutral-600" />
        <span className="truncate">{effortText}</span>
      </button>
      <ContextStatus usage={usage} compacting={compacting} />
    </div>
  )
}

/** 선택 카드 1개의 옵션. value '' = 전역 설정 따름(Default). */
type PickerOption = { value: string; label: string; hint?: string }

/**
 * 입력창 위에 뜨는 /model·/effort 선택 카드. 백엔드 왕복 없이 로컬에서 값을 고른다 —
 * 현재 값을 강조하고, ↑↓ 로 이동·Enter 로 적용·Esc 로 닫는다(카드가 입력창 위에 떠 있고
 * 포커스는 textarea 에 남으므로 document 캡처 단계에서 키를 가로챈다, McpPanel 과 동일한 방식).
 * 모델/effort 는 query 시작 시점에 고정되므로 변경 시 세션이 재시작된다 — 그래서 턴 진행 중에는
 * 적용을 막고 안내만 보여 준다(헤더 드롭다운 시절의 동작과 동일).
 */
function PickerCard({
  kind,
  workspace,
  running,
  onClose
}: {
  kind: 'model' | 'effort'
  workspace: Workspace
  running: boolean
  onClose: () => void
}): React.JSX.Element {
  const settingsModel = useStore((s) => s.app!.settings.model)
  const settingsEffort = useStore((s) => s.app!.settings.effort)

  const options = useMemo<PickerOption[]>(() => {
    if (kind === 'model') {
      const base: PickerOption[] = [
        { value: '', label: 'Default', hint: modelLabel(settingsModel) },
        ...MODEL_OPTIONS.map((m) => ({ value: m.id, label: m.label }))
      ]
      // 목록에 없는 커스텀 모델을 이미 쓰고 있으면 그 항목도 노출해 선택 상태가 보이도록.
      if (workspace.model && !MODEL_OPTIONS.some((m) => m.id === workspace.model)) {
        base.push({ value: workspace.model, label: workspace.model })
      }
      return base
    }
    return [
      { value: '', label: 'Default', hint: effortLabel(settingsEffort) },
      ...EFFORT_OPTIONS.map((e) => ({ value: e.id, label: e.label, hint: e.hint }))
    ]
  }, [kind, settingsModel, settingsEffort, workspace.model])

  const current = kind === 'model' ? (workspace.model ?? '') : (workspace.effort ?? '')
  const currentIdx = Math.max(
    0,
    options.findIndex((o) => o.value === current)
  )
  const [cursor, setCursor] = useState(currentIdx)
  const activeRef = useRef<HTMLButtonElement | null>(null)

  const apply = (value: string): void => {
    if (running) return // 턴 진행 중에는 세션 재시작을 막는다(안내만).
    if (value !== current) {
      if (kind === 'model') void window.api.workspace.setModel(workspace.id, value || null)
      else
        void window.api.workspace.setEffort(workspace.id, (value || null) as EffortSetting | null)
    }
    onClose()
  }

  // 최신 상태를 보는 키 핸들러를 매 렌더 갱신하고 리스너는 한 번만 바인딩한다(stale closure 방지).
  const handlerRef = useRef<(e: KeyboardEvent) => void>(() => {})
  handlerRef.current = (e: KeyboardEvent): void => {
    if (!['ArrowUp', 'ArrowDown', 'Enter', 'Escape'].includes(e.key)) return
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') onClose()
    else if (e.key === 'ArrowDown') setCursor((c) => (c + 1) % options.length)
    else if (e.key === 'ArrowUp') setCursor((c) => (c - 1 + options.length) % options.length)
    else if (e.key === 'Enter') apply(options[Math.min(cursor, options.length - 1)].value)
  }
  useEffect(() => {
    const listener = (e: KeyboardEvent): void => handlerRef.current(e)
    document.addEventListener('keydown', listener, true)
    return () => document.removeEventListener('keydown', listener, true)
  }, [])

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [cursor])

  const title = kind === 'model' ? '/model' : '/effort'
  const icon =
    kind === 'model' ? (
      <Cpu size={13} className="text-[var(--accent-400)] shrink-0" />
    ) : (
      <Zap size={13} className="text-[var(--accent-400)] shrink-0" />
    )

  return (
    <div className="absolute bottom-full mb-2 left-0 right-0 max-h-96 overflow-y-auto rounded-xl border border-[var(--accent-500)]/30 bg-[var(--bg-3)] shadow-2xl z-20">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-[var(--border)] sticky top-0 bg-[var(--bg-3)]">
        {icon}
        <span className="text-sm font-medium text-[var(--accent-300)] shrink-0">{title}</span>
        <span className="text-xs text-neutral-500 truncate">
          {kind === 'model' ? 'Model for this workspace' : 'Reasoning effort for this workspace'}
        </span>
        <span className="ml-auto shrink-0 text-xs text-neutral-600 select-none">Esc to close</span>
        <button
          onClick={onClose}
          title="Dismiss (Esc)"
          className="shrink-0 h-5 w-5 grid place-items-center rounded text-neutral-500 hover:text-neutral-200 hover:bg-[var(--surface-3)]"
        >
          <X size={13} />
        </button>
      </div>
      <div className="py-1">
        {options.map((opt, i) => {
          const active = i === cursor
          const selected = opt.value === current
          return (
            <button
              key={opt.value || '__default'}
              ref={(el) => {
                if (active) activeRef.current = el
              }}
              onMouseEnter={() => setCursor(i)}
              onMouseDown={(e) => {
                e.preventDefault() // textarea blur 방지
                apply(opt.value)
              }}
              disabled={running}
              className={
                'w-full flex items-baseline gap-2 px-3 py-1.5 text-left disabled:cursor-not-allowed ' +
                (active ? 'bg-[var(--surface-3)]' : 'hover:bg-[var(--surface)]')
              }
            >
              <Check
                size={12}
                className={
                  'shrink-0 translate-y-0.5 ' +
                  (selected ? 'text-[var(--accent-400)]' : 'text-transparent')
                }
              />
              <span className="text-sm font-medium text-neutral-100 shrink-0">{opt.label}</span>
              {opt.hint && <span className="text-xs text-neutral-500 truncate">{opt.hint}</span>}
            </button>
          )
        })}
      </div>
      <div className="px-3 py-1.5 text-xs text-neutral-600 border-t border-[var(--border)]">
        {running ? 'Stop the current turn to change it.' : '↑↓ navigate · ↵ select · esc close'}
      </div>
    </div>
  )
}

/** 상태줄 우측의 컨텍스트 사용량 표시(막대 + 퍼센트 · 압축 중 · 데이터 없음). */
function ContextStatus({
  usage,
  compacting
}: {
  usage?: { usedTokens: number; maxTokens: number; percentage: number }
  compacting: boolean
}): React.JSX.Element {
  if (compacting) {
    return (
      <span className="ml-auto shrink-0 flex items-center gap-1.5 text-[var(--accent-400)]">
        <span className="h-2.5 w-2.5 rounded-full border-2 border-[var(--accent-400)]/40 border-t-violet-400 animate-spin" />
        Compacting…
      </span>
    )
  }

  // 첫 턴 전(사용량 미집계)에도 항상 노출 — 자리만 잡고 "—" 로 표시한다.
  if (!usage || usage.maxTokens <= 0) {
    return (
      <span
        className="ml-auto shrink-0 flex items-center gap-1.5 text-neutral-600"
        title="Context usage appears after the first turn"
      >
        <Gauge size={11} className="shrink-0" />
        context —
      </span>
    )
  }

  const pct = Math.min(100, Math.round(usage.percentage * 100))
  // 70% 미만 중립, 70~89% 주의(amber), 90%+ 위험(red).
  const tone =
    pct >= 90
      ? 'text-[var(--danger-400)]'
      : pct >= 70
        ? 'text-[var(--warning-400)]'
        : 'text-neutral-500'
  const barTone =
    pct >= 90 ? 'bg-[var(--danger-400)]' : pct >= 70 ? 'bg-[var(--warning-400)]' : 'bg-neutral-500'

  return (
    <span
      className={'ml-auto shrink-0 flex items-center gap-1.5 ' + tone}
      title={`Context: ${usage.usedTokens.toLocaleString()} / ${usage.maxTokens.toLocaleString()} tokens (${pct}%)`}
    >
      <Gauge size={11} className="shrink-0" />
      <span className="h-1 w-16 rounded-full bg-[var(--surface-3)] overflow-hidden">
        <span className={'block h-full rounded-full ' + barTone} style={{ width: `${pct}%` }} />
      </span>
      {pct}%
    </span>
  )
}

const EMPTY: ChatItem[] = []
const EMPTY_QUEUE: import('../store').QueuedMessage[] = []
