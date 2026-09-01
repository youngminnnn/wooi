import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { wasInterrupted, workspaceDisplayName, type Workspace } from '@shared/types'
import { askSummary } from '@shared/askSummary'
import type { PermissionRequest } from '@shared/types'
import { useStore } from '../store'
import {
  announceChange,
  newToastMessages,
  subscribeAnnouncements,
  type AnnounceSnapshot,
  type AnnounceState,
  type Announcement
} from '../lib/announce'

/**
 * 앱 전체에서 **유일한** 라이브 리전 호스트. `App.tsx` 에 딱 한 번 마운트된다.
 *
 * 화면에는 아무것도 그리지 않는다(sr-only) — 이 컴포넌트가 하는 일은 스크린리더가 읽을 문장을
 * DOM 에 갈아 끼우는 것뿐이다.
 *
 * **왜 한 곳인가**: 컴포넌트마다 `aria-live` 를 흩뿌리면 같은 사건이 여러 리전에서 겹쳐 읽히고,
 * 어느 것이 먼저 읽힐지 순서도 통제할 수 없다. 점진적 힌트를 `Hint.tsx` 하나에 모은 것과 같은
 * 구조다 — 판정은 순수 함수(`lib/announce.ts`)에, 상태 보관과 DOM 은 여기 한 곳에.
 *
 * **리전을 셋으로 나눈 이유**: 하나에 몰면 같은 틱에 두 사건이 나면 나중 것이 앞 것을 덮어써
 * 조용히 사라진다. 소유자가 다른 문장은 리전도 다르게 둔다 — 스크린리더는 여러 polite 리전의
 * 메시지를 큐에 쌓아 차례로 읽어 준다.
 *
 * 라이브 리전은 **요소가 먼저 DOM 에 있어야** 그 뒤의 텍스트 변경을 사건으로 인식한다. 그래서
 * 조건부로 마운트하지 않고 언제나 빈 채로 붙어 있는다.
 */
export default function LiveRegion(): React.JSX.Element {
  // 턴 시작/종료(polite) · 토스트(polite) · 응답 대기와 오류(assertive).
  const [turn, setTurn] = useState('')
  const [toast, setToast] = useState('')
  const [alert, setAlert] = useState('')

  const workspaces = useStore((s) => s.app?.workspaces)
  const selectedId = useStore((s) => s.selectedWorkspaceId)
  const permissions = useStore((s) => s.permissions)
  const prStatus = useStore((s) => s.prStatus)
  const toasts = useStore((s) => s.toasts)

  const workspace = useMemo(
    () => (selectedId ? (workspaces?.find((w) => w.id === selectedId) ?? null) : null),
    [workspaces, selectedId]
  )
  const pending = useMemo(
    () => (workspace ? (permissions.find((p) => p.workspaceId === workspace.id) ?? null) : null),
    [permissions, workspace]
  )
  const prTitle = workspace ? (prStatus[workspace.id]?.title ?? null) : null

  const snapshot = useMemo<AnnounceSnapshot | null>(
    () =>
      workspace
        ? {
            workspaceId: workspace.id,
            workspaceName: workspaceDisplayName(workspace, prTitle),
            state: announceStateOf(workspace, pending)
          }
        : null,
    [workspace, pending, prTitle]
  )

  // 직전 스냅샷. 이 ref 하나가 이 층의 유일한 상태다 — 무엇을 읽을지의 판단은 전부 순수 함수에 있다.
  const prevSnapshot = useRef<AnnounceSnapshot | null>(null)

  const push = useCallback((announcement: Announcement): void => {
    // 같은 문자열을 다시 넣으면 React 가 렌더를 건너뛰어 DOM 이 그대로다 → 스크린리더도 다시
    // 읽지 않는다. announceChange 의 중복 억제와 같은 결론에 두 겹으로 도달하는 셈이라 그대로 둔다.
    if (announcement.politeness === 'assertive') setAlert(announcement.message)
    else setTurn(announcement.message)
  }, [])

  useEffect(() => {
    if (!snapshot) {
      // 선택된 워크스페이스가 없으면(전체 현황판 등) 기준선을 지운다 — 돌아왔을 때 그동안의
      // 변화를 몰아서 읽는 대신 조용히 다시 시작한다.
      prevSnapshot.current = null
      return
    }
    const announcement = announceChange(prevSnapshot.current, snapshot)
    prevSnapshot.current = snapshot
    if (announcement) push(announcement)
  }, [snapshot, push])

  // 이미 읽은 토스트 id. null 이면 아직 기준선을 잡기 전(첫 렌더)이라 그때 떠 있던 것은 읽지 않는다.
  const seenToasts = useRef<Set<string> | null>(null)
  useEffect(() => {
    const ids = new Set(toasts.map((t) => t.id))
    if (seenToasts.current === null) {
      seenToasts.current = ids
      return
    }
    const fresh = newToastMessages(seenToasts.current, toasts)
    seenToasts.current = ids
    if (fresh.length) setToast(fresh.join(' '))
  }, [toasts])

  // 스토어에 남지 않는 사건(ErrorBoundary 의 렌더 오류)이 들어오는 통로.
  useEffect(
    () =>
      subscribeAnnouncements((announcement) => {
        if (announcement.politeness === 'assertive') setAlert(announcement.message)
        else setToast(announcement.message)
      }),
    []
  )

  // `role="alert"`/`role="status"` 를 쓰지 않고 `aria-live` 만 둔다. 읽히는 결과는 같지만
  // (role="alert" 는 assertive + atomic 의 준말이다), 이 리전들은 **비어 있는 채로 늘 떠
  // 있는 그릇**이라 role 을 달면 "지금 경보가 하나 떠 있다" 로 읽힌다. 실제로 그렇게 읽는
  // 코드가 이미 있다 — e2e 가 `getByRole('alert')` 로 토스트를 세고 그것이 사라지기를
  // 기다린다. 상시 마운트된 빈 alert 는 영영 사라지지 않으므로 그 기다림은 반드시 죽는다.
  // 그래서 ARIA 는 읽히는 일에만 쓰고, 가리키는 일은 전용 훅(data-live-region)에 맡긴다.
  return (
    <>
      <div className="sr-only" data-live-region="turn" aria-live="polite" aria-atomic="true">
        {turn}
      </div>
      <div className="sr-only" data-live-region="toast" aria-live="polite" aria-atomic="true">
        {toast}
      </div>
      <div className="sr-only" data-live-region="alert" aria-live="assertive" aria-atomic="true">
        {alert}
      </div>
    </>
  )
}

/**
 * 워크스페이스 하나를 알릴 수 있는 상태로 줄인다. 우선순위는 `describeWorkspaceStatus` 의
 * 사다리와 같은 순서다 — 두 층이 서로 다른 것을 말하면 화면과 소리가 갈린다.
 *
 * 압축 중(compacting)은 여기서 running 에 접힌다. 사이드바에서는 색으로 구분할 값어치가 있지만,
 * 소리로는 "돌고 있다" 는 같은 사실이라 두 번 알릴 이유가 없다.
 */
function announceStateOf(workspace: Workspace, pending: PermissionRequest | null): AnnounceState {
  if (pending) return { kind: 'awaiting-response', ask: askSummary(pending) || undefined }
  if (workspace.status === 'running') return { kind: 'running' }
  if (workspace.status === 'error') return { kind: 'error' }
  if (wasInterrupted(workspace)) return { kind: 'interrupted' }
  return { kind: 'idle' }
}
