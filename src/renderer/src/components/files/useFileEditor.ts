import { useCallback, useEffect, useMemo, useState } from 'react'
import { useStore } from '../../store'
import { canEditFile, isDraftDirty, detectEol, applyEol, type Eol } from '@shared/fileEdit'
import type { FileContent, FileSaveConflict } from '@shared/types'

/** 저장이 막혔을 때 사용자에게 보여 줄 것 — 왜 막혔는지와, 비교할 상대편 내용. */
export interface EditorConflict {
  conflict: FileSaveConflict
  /** 지금 디스크에 있는 내용. 파일이 사라졌으면 null. */
  current: FileContent | null
}

/** 파일 하나의 편집 중인 상태. 열었을 때의 내용을 함께 들고 있어야 저장할 때 비교할 수 있다. */
interface DraftEntry {
  draft: string
  /** 편집을 시작할 때의 본문. 이것과 같아지면 dirty 가 아니다. */
  baselineText: string
  /** 편집을 시작할 때의 sha. 저장할 때 디스크와 맞춰 볼 기준값이다. */
  baselineSha: string
  /** 열었을 때의 줄바꿈 표기. textarea 는 LF 로 정규화하므로 저장할 때 되돌린다. */
  eol: Eol
}

export interface FileEditor {
  /** 지금 보고 있는 파일의 편집 중인 본문. null 이면 읽기 전용 상태다. */
  draft: string | null
  editing: boolean
  /** 지금 보고 있는 파일에 저장하지 않은 변경이 있는가. */
  dirty: boolean
  /** 뷰어를 통틀어 저장하지 않은 파일이 하나라도 있는가(닫기 확인용). */
  dirtyPaths: string[]
  saving: boolean
  conflict: EditorConflict | null
  /** 이 파일이 애초에 고칠 수 있는 것인가(바이너리·잘린 파일은 아니다). */
  canEdit: boolean
  begin: () => void
  change: (text: string) => void
  /** 편집을 접고 이 파일의 초안을 버린다. */
  cancel: () => void
  /** 저장한다. `force` 는 충돌 경고를 보고 덮어쓰기를 고른 경우. */
  save: (force?: boolean) => Promise<void>
  /** 충돌 배너에서 "디스크 것을 쓴다" — 내 초안을 버리고 디스크에 있는 내용으로 갈아탄다. */
  takeDisk: () => void
  /** 충돌 배너만 닫는다(초안은 그대로 두고 계속 고친다). */
  dismissConflict: () => void
  /** 모든 초안을 버린다(닫기 확인에서 사용자가 버리기를 골랐을 때). */
  discardAll: () => void
}

/**
 * 파일 뷰어의 인라인 편집 상태.
 *
 * 오버레이 뷰어와 All files 패널이 **같은 저장 규칙**을 써야 해서 훅으로 뺐다. 특히 충돌
 * 처리는 한쪽에만 있으면 없는 쪽이 남의 작업을 덮어쓰는 길이 된다.
 *
 * 초안은 **경로별로** 들고 있다. 뷰어는 브라우저처럼 앞뒤로 오가는 물건이라, 고치던 중에
 * 다른 파일을 잠깐 열어 보는 일이 자연스럽다 — 그때마다 초안을 버리면 사용자는 뷰어 안에서
 * 이동하기를 두려워하게 된다. 덕분에 초안을 잃을 수 있는 지점이 "뷰어를 닫을 때" 하나로
 * 모이고, 확인도 거기 한 곳에만 두면 된다.
 *
 * 본문(`content`)의 주인은 부모다. 내용이 새로 확정될 때마다(저장 성공, 또는 충돌에서
 * 디스크 것을 택할 때) `onContent` 로 올려 보내 부모가 화면을 갱신하게 한다.
 */
export function useFileEditor({
  workspaceId,
  path,
  content,
  onContent
}: {
  workspaceId: string
  path: string | null
  content: FileContent | null
  /** 새로 확정된 파일 내용(저장 결과이거나, 충돌에서 택한 디스크 내용). */
  onContent: (next: FileContent) => void
}): FileEditor {
  const pushToast = useStore((s) => s.pushToast)
  const [entries, setEntries] = useState<Record<string, DraftEntry>>({})
  const [saving, setSaving] = useState(false)
  // 충돌은 그 파일에 대한 것이라 경로를 함께 들고, 다른 파일을 보는 동안에는 그냥 안 보여 준다.
  const [conflictAt, setConflictAt] = useState<(EditorConflict & { path: string }) | null>(null)

  const conflict = conflictAt && conflictAt.path === path ? conflictAt : null
  const entry = path ? entries[path] : undefined
  const canEdit = canEditFile(content)
  const dirty = entry ? isDraftDirty(entry.draft, entry.baselineText) : false

  const dirtyPaths = useMemo(
    () =>
      Object.keys(entries).filter((p) => isDraftDirty(entries[p].draft, entries[p].baselineText)),
    [entries]
  )

  // 워크스페이스가 바뀌면 초안은 통째로 버린다 — 경로가 같아도 다른 worktree 의 다른 파일이다.
  useEffect(() => {
    setEntries({})
    setConflictAt(null)
    setSaving(false)
  }, [workspaceId])

  const begin = useCallback(() => {
    if (!canEdit || !content || !path) return
    setEntries((prev) =>
      // 이미 초안이 있으면(다른 파일 보고 돌아온 경우) 그대로 이어서 고친다.
      prev[path]
        ? prev
        : {
            ...prev,
            [path]: {
              draft: content.text,
              baselineText: content.text,
              baselineSha: content.sha,
              eol: detectEol(content.text)
            }
          }
    )
  }, [canEdit, content, path])

  const change = useCallback(
    (text: string) => {
      if (!path) return
      setEntries((prev) =>
        prev[path] ? { ...prev, [path]: { ...prev[path], draft: text } } : prev
      )
    },
    [path]
  )

  const drop = useCallback((target: string) => {
    setEntries((prev) => {
      if (!prev[target]) return prev
      const next = { ...prev }
      delete next[target]
      return next
    })
  }, [])

  const cancel = useCallback(() => {
    if (path) drop(path)
    setConflictAt(null)
  }, [path, drop])

  const discardAll = useCallback(() => {
    setEntries({})
    setConflictAt(null)
  }, [])

  const takeDisk = useCallback(() => {
    // 배너를 닫는 것만으로는 부족하다 — 부모가 든 content 는 아직 열었을 때의 낡은 내용이라,
    // 여기서 디스크 내용으로 갈아타 주지 않으면 "버렸다" 고 해 놓고 낡은 본문을 보여 준다.
    // 충돌 응답이 이미 지금 디스크 내용을 실어 왔으므로 다시 읽을 필요는 없다.
    if (conflict?.current) onContent(conflict.current)
    if (path) drop(path)
    setConflictAt(null)
  }, [conflict, onContent, path, drop])

  const dismissConflict = useCallback(() => setConflictAt(null), [])

  const save = useCallback(
    async (force = false) => {
      if (!path || !entry) return
      setSaving(true)
      try {
        const res = await window.api.fs.write(
          workspaceId,
          path,
          applyEol(entry.draft, entry.eol),
          // 기준은 **초안을 뜬 시점**의 sha 다. 부모가 든 content 는 그 사이 새로고침으로
          // 바뀌었을 수 있고, 그걸 기준 삼으면 못 본 변경을 봤다고 치는 셈이 된다.
          entry.baselineSha,
          force
        )
        if (res.ok) {
          setConflictAt(null)
          drop(path)
          onContent(res.content)
          pushToast('info', `Saved ${path}`)
          return
        }
        if (res.reason === 'conflict') {
          // 초안은 그대로 둔다 — 여기서 날리면 사용자가 방금 친 것이 사라진다.
          setConflictAt({ path, conflict: res.conflict, current: res.current })
          return
        }
        pushToast(
          'error',
          res.reason === 'denied'
            ? `Can’t write ${path} in this workspace.`
            : `Couldn’t save ${path} — ${res.message}`
        )
      } finally {
        setSaving(false)
      }
    },
    [workspaceId, path, entry, drop, onContent, pushToast]
  )

  return {
    draft: entry?.draft ?? null,
    editing: !!entry,
    dirty,
    dirtyPaths,
    saving,
    conflict,
    canEdit,
    begin,
    change,
    cancel,
    save,
    takeDisk,
    dismissConflict,
    discardAll
  }
}
