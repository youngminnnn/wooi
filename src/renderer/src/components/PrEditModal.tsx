import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import Modal, { ghostBtn, inputClass, labelClass, primaryBtn } from './Modal'
import { useStore } from '../store'
import type { PrStatus } from '@shared/types'

/**
 * PR 제목·본문을 앱 안에서 고친다. 에이전트가 연 PR 의 제목을 사람이 다듬는 건 잦은 일이라,
 * 그때마다 브라우저로 나가지 않게 한다.
 *
 * 원문은 열릴 때 따로 읽는다 — PrStatus 는 본문을 싣지 않고(폴링마다 실어 나르게 되므로),
 * 제목도 리포 단위 목록 캐시에서 온 값이라 낡았을 수 있다. 다 읽기 전에는 저장을 막아,
 * 못 본 본문을 빈 문자열로 덮어쓰는 일이 없게 한다.
 */
export default function PrEditModal({
  workspaceId,
  pr,
  onClose
}: {
  workspaceId: string
  pr: PrStatus
  onClose: () => void
}): React.JSX.Element {
  const pushToast = useStore((s) => s.pushToast)
  const refreshPr = useStore((s) => s.refreshPr)

  const [loaded, setLoaded] = useState(false)
  const [title, setTitle] = useState(pr.title)
  const [body, setBody] = useState('')
  // 저장할 때 "무엇이 실제로 바뀌었는지" 를 가리는 기준. 손대지 않은 필드는 아예 보내지 않아,
  // 그 사이 GitHub 에서 바뀐 값을 우리가 되돌리지 않게 한다.
  const [original, setOriginal] = useState<{ title: string; body: string } | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let alive = true
    void window.api.pr.editable(workspaceId).then((editable) => {
      if (!alive) return
      if (editable) {
        setTitle(editable.title)
        setBody(editable.body)
        setOriginal(editable)
      }
      setLoaded(true)
    })
    return () => {
      alive = false
    }
  }, [workspaceId])

  // 제목이 비면 GitHub 이 422 로 거절한다 — 눌러 보고 실패하는 대신 미리 막는다.
  // 본문은 비워도 된다: 통째로 지우는 것도 정당한 편집이다.
  const changed = !!original && (title !== original.title || body !== original.body)
  const canSave = loaded && !busy && !!original && changed && title.trim().length > 0

  const save = async (): Promise<void> => {
    if (!canSave || !original) return
    setBusy(true)
    const res = await window.api.pr
      .edit(workspaceId, {
        ...(title === original.title ? {} : { title }),
        ...(body === original.body ? {} : { body })
      })
      .catch((err) => ({ error: err instanceof Error ? err.message : String(err) }))
    setBusy(false)
    if (res.error) {
      pushToast('error', `Edit failed: ${res.error}`)
      return
    }
    pushToast('success', `Updated #${pr.number}.`)
    onClose()
    await refreshPr(workspaceId)
  }

  return (
    <Modal
      title={`Edit pull request #${pr.number}`}
      onClose={onClose}
      width={620}
      footer={
        <>
          <button onClick={onClose} className={ghostBtn}>
            Cancel
          </button>
          <button onClick={() => void save()} disabled={!canSave} className={primaryBtn}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </>
      }
    >
      {!loaded ? (
        <div className="flex items-center gap-2 py-6 text-sm text-neutral-400">
          <Loader2 size={14} className="animate-spin" />
          Loading the pull request…
        </div>
      ) : !original ? (
        <p className="py-6 text-sm text-neutral-400">
          Wooi could not read this pull request. Check the GitHub CLI connection and try again.
        </p>
      ) : (
        <div className="space-y-4">
          <div>
            <label className={labelClass} htmlFor="pr-edit-title">
              Title
            </label>
            <input
              id="pr-edit-title"
              className={inputClass}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                // IME 조합 중의 Enter 는 한글 확정이지 저장이 아니다.
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) void save()
              }}
              placeholder="Pull request title"
            />
            <p className="mt-1.5 text-xs text-neutral-500">
              This is also the workspace name in the sidebar, unless you renamed it yourself.
            </p>
          </div>

          <div>
            <label className={labelClass} htmlFor="pr-edit-body">
              Description
            </label>
            <textarea
              id="pr-edit-body"
              className={`${inputClass} min-h-[220px] resize-y font-mono text-sm`}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.nativeEvent.isComposing) {
                  void save()
                }
              }}
              placeholder="Markdown — leave empty for no description."
            />
            <p className="mt-1.5 text-xs text-neutral-500">&#8984;&#8629; to save.</p>
          </div>
        </div>
      )}
    </Modal>
  )
}
