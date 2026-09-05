import { useCallback, useEffect, useRef, useState } from 'react'
import { FileCode2, Loader2, Trash2 } from 'lucide-react'
import { ARTIFACT_PARTITION } from '@shared/types'
import type { ArtifactSummary, Workspace } from '@shared/types'
import { artifactUrl } from '@shared/artifactUrl'
import type { PreviewWebview } from '../lib/webview'
import { MarkdownBody } from './ChatPrimitives'

/**
 * Artifacts 탭 — 에이전트가 만든 것을 **실행해서** 본다.
 *
 * Preview 와 나란히 서지만 신뢰 수준이 반대다. Preview 의 게스트는 사용자 자신의 dev 서버라
 * 웹을 돌아다녀도 되고, 여기 게스트는 모델이 쓴 코드라 아무 데도 못 간다. 그 차이는 전부
 * main 이 집행한다([[main/artifactProtocol]], [[main/preview]] `guardArtifactGuest`) —
 * 이 파일은 그 울타리 **안에** 무엇을 띄울지만 정한다.
 *
 * 목록을 zustand 스토어에 두지 않고 여기서 직접 IPC 로 읽는 이유가 있다. 작업 패널은 분리된
 * 창으로 떨어질 수 있고, 스토어 구독은 `init()` 과 `initPane()` **양쪽**에 걸어야 한다 —
 * 한쪽을 빠뜨리면 분리 창에서 에러 없이 조용히 죽는다. 패널이 자기 것을 자기가 읽으면 그
 * 갈래가 아예 생기지 않는다.
 */

/** Preview 와 같은 값. 태그만 읽는 사람에게도 "이 뷰는 격리돼 있다" 가 보여야 한다. */
const GUEST_PREFS = 'contextIsolation=yes,sandbox=yes,nodeIntegration=no,javascript=yes'

/**
 * 게스트를 붙이기 위한 최초 `src`. **반드시 있어야 하고, 반드시 상수여야 한다** —
 * 이유는 [[PreviewPanel]] 의 같은 상수에 적어 두었다(빈 `src` 면 게스트가 안 생기고,
 * React 가 매 렌더마다 prop 을 다시 써 넣으면 보던 페이지가 되감긴다).
 */
const BOOT_URL = 'about:blank'

export default function ArtifactPanel({
  workspace,
  target,
  active
}: {
  workspace: Workspace
  /**
   * WorkPanel 이 넘기는 "이걸 열어라" 명령(create_artifact 가 방금 만든 것).
   * seq 가 바뀔 때만 따라간다 — 같은 명령을 두 번 따라가면 사용자가 방금 고른 버전을 뺏는다.
   */
  target: { artifactId: string; version: number; seq: number } | null
  /** 지금 이 탭이 보이는지. 감춰져 있는 동안에는 원본을 당겨 오지 않는다. */
  active: boolean
}): React.JSX.Element {
  const viewRef = useRef<PreviewWebview | null>(null)
  /** 이미 따라간 명령의 seq. */
  const handledSeq = useRef<number | null>(null)

  const [list, setList] = useState<ArtifactSummary[] | null>(null)
  /** 사용자가 **명시적으로** 고른 것. null 이면 목록의 맨 앞(가장 최근)을 따라간다. */
  const [pickedId, setPickedId] = useState<string | null>(null)
  const [version, setVersion] = useState<number | null>(null)
  // 게스트가 붙기 전에는 loadURL 이 던진다. dom-ready 를 본 뒤에만 명령을 보낸다.
  const [ready, setReady] = useState(false)
  /**
   * 마크다운은 웹뷰를 타지 않는다 — 앱 안에서 기존 MarkdownBody 로 그린다.
   * 어느 (id, version) 의 것인지 함께 들고 있어야 선택을 바꾼 직후 옛 본문이 잠깐 남지 않는다.
   */
  const [markdown, setMarkdown] = useState<{ id: string; version: number; text: string } | null>(
    null
  )

  // 무엇을 보고 있는지는 전부 **파생**이다. 목록이 바뀔 때 골라 주는 effect 를 두면 그
  // effect 가 렌더를 한 번 더 유발하고, "고른 것" 과 "목록" 이 잠깐 어긋난 채로 그려진다.
  const selected = list?.find((a) => a.id === pickedId) ?? list?.[0] ?? null
  const shownVersion = version ?? selected?.versions[0] ?? null
  const isMarkdown = selected?.kind === 'markdown'
  const markdownText =
    isMarkdown && markdown?.id === selected.id && markdown.version === shownVersion
      ? markdown.text
      : null

  const refresh = useCallback(async (): Promise<ArtifactSummary[]> => {
    const next = await window.api.artifact.list(workspace.id)
    setList(next)
    return next
  }, [workspace.id])

  // 목록: 마운트 때 한 번, 그리고 main 이 바뀌었다고 알릴 때마다.
  useEffect(() => {
    void refresh()
    return window.api.artifact.onChanged((e) => {
      if (e.workspaceId !== workspace.id) return
      void refresh()
    })
  }, [workspace.id, refresh])

  // 도구가 방금 만든 것으로 따라간다.
  useEffect(() => {
    if (!target || handledSeq.current === target.seq) return
    handledSeq.current = target.seq
    setPickedId(target.artifactId)
    setVersion(target.version)
  }, [target])

  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const onDomReady = (): void => setReady(true)
    view.addEventListener('dom-ready', onDomReady)
    return () => view.removeEventListener('dom-ready', onDomReady)
  }, [])

  // 고른 것을 게스트에 밀어 넣는다. `src` prop 이 아니라 명령형 loadURL 이어야 한다 —
  // prop 에 매달면 상태가 한 번 흐를 때마다 보던 화면이 처음으로 되감긴다.
  useEffect(() => {
    if (!selected || shownVersion === null) return

    if (selected.kind === 'markdown') {
      if (!active) return undefined
      const { id } = selected
      let cancelled = false
      void window.api.artifact.read(workspace.id, id, shownVersion).then((src) => {
        if (!cancelled) setMarkdown({ id, version: shownVersion, text: src?.text ?? '' })
      })
      return () => {
        cancelled = true
      }
    }

    const view = viewRef.current
    if (!view || !ready) return
    void view.loadURL(artifactUrl(workspace.id, selected.id, shownVersion)).catch(() => {
      /* 게스트가 사라지는 중. 다음 선택이 다시 시도한다. */
    })
    return undefined
  }, [workspace.id, selected, shownVersion, ready, active])

  const remove = async (id: string): Promise<void> => {
    await window.api.artifact.remove(workspace.id, id)
    const next = await refresh()
    if (selected?.id === id) {
      setPickedId(next[0]?.id ?? null)
      setVersion(null)
    }
  }

  return (
    <div className="h-full flex min-h-0">
      <ArtifactList
        list={list}
        selectedId={selected?.id ?? null}
        onSelect={(id) => {
          setPickedId(id)
          setVersion(null)
        }}
        onRemove={(id) => void remove(id)}
      />

      <div className="flex-1 min-w-0 flex flex-col min-h-0">
        {selected && selected.versions.length > 1 && (
          <div className="flex items-center gap-2 px-3 py-1.5 border-b border-neutral-800 text-2xs text-neutral-400">
            <span className="truncate">{selected.title}</span>
            <select
              className="ml-auto bg-neutral-900 border border-neutral-700 rounded px-1.5 py-0.5"
              aria-label="Version"
              value={shownVersion ?? ''}
              onChange={(e) => setVersion(Number(e.target.value))}
            >
              {selected.versions.map((v) => (
                <option key={v} value={v}>
                  v{v}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="relative flex-1 min-h-0 bg-white">
          {/* 게스트는 언마운트하지 않고 감춘다 — 마크다운으로 옮겨 갈 때마다 게스트를 버리면
              다시 HTML 아티팩트를 열 때 처음부터 붙어야 한다. */}
          <webview
            ref={(el) => {
              viewRef.current = el
            }}
            src={BOOT_URL}
            partition={ARTIFACT_PARTITION}
            webpreferences={GUEST_PREFS}
            className={isMarkdown ? 'hidden' : 'absolute inset-0'}
            style={{ width: '100%', height: '100%' }}
          />
          {isMarkdown && markdownText !== null && (
            <div className="absolute inset-0 overflow-auto bg-neutral-950 px-5 py-4">
              <div className="md text-base text-neutral-200">
                <MarkdownBody text={markdownText} />
              </div>
            </div>
          )}
          {list !== null && list.length === 0 && <EmptyState />}
          {list === null && (
            <div className="absolute inset-0 grid place-items-center bg-neutral-950">
              <Loader2 size={16} className="animate-spin text-neutral-500" />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function ArtifactList({
  list,
  selectedId,
  onSelect,
  onRemove
}: {
  list: ArtifactSummary[] | null
  selectedId: string | null
  onSelect: (id: string) => void
  onRemove: (id: string) => void
}): React.JSX.Element | null {
  if (!list?.length) return null
  return (
    <div className="w-48 shrink-0 border-r border-neutral-800 overflow-y-auto py-1">
      {list.map((a) => (
        <div
          key={a.id}
          className={`group flex items-center gap-1.5 px-2 py-1.5 text-xs cursor-pointer ${
            a.id === selectedId ? 'bg-neutral-800 text-neutral-100' : 'text-neutral-400'
          }`}
          onClick={() => onSelect(a.id)}
        >
          <FileCode2 size={13} className="shrink-0 opacity-70" />
          <span className="truncate flex-1">{a.title}</span>
          <button
            className="opacity-0 group-hover:opacity-100 text-neutral-500 hover:text-neutral-200"
            aria-label={`Delete ${a.title}`}
            title="Delete"
            onClick={(e) => {
              e.stopPropagation()
              onRemove(a.id)
            }}
          >
            <Trash2 size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}

function EmptyState(): React.JSX.Element {
  return (
    <div className="absolute inset-0 grid place-items-center bg-neutral-950 px-6 text-center">
      <div className="max-w-xs">
        <FileCode2 size={20} className="mx-auto mb-2 text-neutral-600" />
        <p className="text-sm text-neutral-400">No artifacts yet.</p>
        <p className="mt-1 text-xs text-neutral-500">
          Ask the agent to build something — a page, a chart, a document — and it shows up here,
          running.
        </p>
      </div>
    </div>
  )
}
