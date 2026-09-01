import type { WebContents } from 'electron'
import { AGENT_TOOL_IMAGE_KEY } from '@shared/agentToolContent'
import { detectDevUrl } from '@shared/devUrl'
import type { PreviewIssue } from '@shared/previewIssues'
import type { RunScript, Workspace } from '@shared/types'
import { captureForAgent, previewGuestFor, previewIssues, requestPreviewOpen } from '../../preview'
import { getStore } from '../../store'
import type { AgentToolDeps, AgentToolHandler } from './registry'

/**
 * 에이전트가 자기 워크스페이스의 Preview 를 눈으로 확인하게 하는 도구들.
 *
 * 지금까지 Preview 는 전부 사람의 왕복이었다 — 사람이 캡처를 눌러 컴포저에 붙이고, 콘솔 에러를
 * 골라 보냈다. 그러면 "고쳤다" 와 "정말 화면이 그렇게 되었다" 사이에 언제나 사람이 한 번 끼어야
 * 한다. 여기 있는 셋은 그 왕복을 에이전트 쪽에서 닫는다 — 열고, 찍고, 에러를 읽는다.
 *
 * **쓰기 동작은 없다.** 클릭·입력은 승인 정책을 따로 설계해야 하고, 읽기만으로도 자가 검증
 * 루프는 닫힌다(고친다 → 다시 연다 → 화면과 콘솔을 본다).
 *
 * 사람이 보는 그 패널을 그대로 쓰는 것이 요점이다(run_script 가 같은 이유로 앱의 스크립트
 * 러너를 쓴다) — 에이전트를 위한 별도의 헤드리스 브라우저를 띄우면 둘이 서로 다른 화면을 보게
 * 되고, 사용자는 에이전트가 무엇을 보고 그렇게 말하는지 확인할 길이 없어진다.
 *
 * 그 선택의 대가는 **화면에 열려 있어야 한다** 는 것이다. Wooi 는 선택된 워크스페이스의
 * WorkPanel 만 마운트하므로(WorkArea 의 key) 게스트도 그때만 존재한다. 이 제약은 감추지 않고
 * 실패 사유에 그대로 적는다.
 */

/** Preview 탭이 뜨고 게스트가 붙기를 기다리는 시간. 보통 1 초 안쪽이다. */
const GUEST_WAIT_MS = 10_000

/** 캡처 전에 로딩이 끝나기를 기다리는 시간. HMR 직후에 찍으면 중간 화면이 나온다. */
const SETTLE_WAIT_MS = 3_000

const POLL_MS = 100

/** 한 번에 돌려줄 문제의 최대 개수와 바이트. 스크립트 로그와 같은 이유의 상한이다. */
const MAX_ISSUES = 50
const MAX_ISSUE_BYTES = 8 * 1024

function workspaceOf(workspaceId: string): Workspace {
  const ws = getStore()
    .getState()
    .workspaces.find((w) => w.id === workspaceId)
  if (!ws) throw new Error('This workspace no longer exists.')
  return ws
}

function runScriptsOf(ws: Workspace): RunScript[] {
  return (
    getStore()
      .getState()
      .repos.find((r) => r.id === ws.repoId)?.runScripts ?? []
  )
}

function runningScripts(deps: AgentToolDeps, ws: Workspace): RunScript[] {
  const statuses = deps.scripts.getStatus(ws.id)
  return runScriptsOf(ws).filter(
    (script) => statuses.find((s) => s.scriptId === script.id)?.state === 'running'
  )
}

/**
 * dev 서버가 어디에 있는지 알아낼 수 없는 이유를 문장으로 만든다.
 *
 * 사유를 세 갈래로 나누는 것이 요점이다 — **스크립트가 없다 / 돌고 있지 않다 / 돌지만 주소를
 * 모른다** 는 에이전트가 취할 다음 행동이 각각 다르다(사용자에게 묻는다 / run_script 를 부른다 /
 * read_script_output 으로 로그를 본다). "미리보기를 열 수 없다" 한 줄로 뭉개면 셋 다 못 한다.
 */
function noDevServerReason(deps: AgentToolDeps, ws: Workspace): string {
  const scripts = runScriptsOf(ws)
  if (!scripts.length) {
    return (
      'This repository has no run script configured, so Wooi does not know how to start or find ' +
      'a dev server — the user sets those in Wooi’s repository settings. Ask them for the dev ' +
      'server command instead of guessing one.'
    )
  }

  const running = runningScripts(deps, ws)
  if (!running.length) {
    const names = scripts.map((s) => `"${s.name}"`).join(', ')
    return (
      `No run script is running in this workspace, so there is no dev server to preview. ` +
      `Start the one that serves the app with run_script (available names: ${names}).`
    )
  }

  const names = running.map((s) => `"${s.name}"`).join(', ')
  return (
    `${names} is running, but it has not printed a local address and Wooi did not assign it a ` +
    'port, so there is no address to open. Read its output with read_script_output to see how ' +
    'far it got, or ask the user which address it serves.'
  )
}

/**
 * 이 워크스페이스의 dev 서버 origin.
 *
 * 돌고 있는 스크립트가 찍은 주소를 가장 믿는다 — 그것이 실제로 열려 있는 포트다. 그다음이 Wooi 가
 * 그 스크립트에 배정한 포트이고, 마지막이 Preview 가 마지막으로 보고 있던 주소다(사용자가 앱
 * 밖에서 dev 서버를 띄우고 주소를 직접 친 경우가 여기 걸린다).
 */
function devOrigin(deps: AgentToolDeps, ws: Workspace): string | null {
  const running = runningScripts(deps, ws)

  for (const script of running) {
    const detected = detectDevUrl(deps.scripts.getOutput(ws.id, script.id))
    if (detected) return originOf(detected)
  }
  for (const script of running) {
    const port = ws.ports[script.id]
    if (port != null) return `http://localhost:${port}`
  }
  return ws.previewUrl ? originOf(ws.previewUrl) : null
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin
  } catch {
    return null
  }
}

/**
 * origin + 모델이 준 경로. 다른 곳으로 새면 거절한다.
 *
 * 경계는 이 한 줄이다 — 이 도구가 열 수 있는 것은 **자기 워크스페이스의 dev 서버**뿐이고,
 * `path` 에 절대 URL 을 적어 그 밖으로 나가는 길을 남기지 않는다.
 */
function urlFor(origin: string, path: string): string {
  const target = (() => {
    try {
      return new URL(path || '/', `${origin}/`)
    } catch {
      return null
    }
  })()
  if (!target) throw new Error(`"${path}" is not a valid path.`)
  if (target.origin !== origin) {
    throw new Error(
      `path must stay on this workspace’s dev server (${origin}); "${path}" points somewhere else.`
    )
  }
  return target.toString()
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** Preview 게스트가 붙기를 기다린다. 시간 안에 안 붙으면 null. */
async function waitForGuest(workspaceId: string): Promise<WebContents | null> {
  const deadline = Date.now() + GUEST_WAIT_MS
  for (;;) {
    const guest = previewGuestFor(workspaceId)
    if (guest) return guest
    if (Date.now() >= deadline) return null
    await delay(POLL_MS)
  }
}

const NO_PANEL =
  'Wooi could not open the preview for this workspace. The preview only exists for the ' +
  'workspace that is currently open on screen, so ask the user to select this workspace (or ' +
  'detach its work panel) and call this again.'

const NOT_OPEN =
  'The preview is not open for this workspace. Call open_preview first — and note that the ' +
  'preview only exists while this workspace is the one open on screen.'

/**
 * 게스트를 그 주소로 보낸다.
 *
 * 이동을 **메인이 직접** 하는 이유: 렌더러에게 이동을 시키면 성공했는지 실패했는지가 돌아오지
 * 않는다. `loadURL` 은 실패를 그대로 던지므로(ERR_CONNECTION_REFUSED 등) 그 문장이 곧 "왜 안
 * 되는지" 가 된다 — 이 앱이 실패 사유를 뭉개지 않는 방식이다.
 */
async function load(guest: WebContents, url: string): Promise<void> {
  try {
    await guest.loadURL(url)
  } catch (err) {
    // 패널이 막 뜨면서 자기 마지막 주소를 한 번 로드한다. 그것과 겹치면 둘 중 하나가 -3 으로
    // 끊기는데, 그건 실패가 아니라 경합이다 — 한 번만 다시 시도한다.
    if (!/ERR_ABORTED/.test(err instanceof Error ? err.message : String(err))) throw err
    await guest.loadURL(url)
  }
}

export const openPreview: AgentToolHandler = async (deps, workspaceId, args) => {
  const ws = workspaceOf(workspaceId)
  const path = typeof args.path === 'string' ? args.path.trim() : ''

  const origin = devOrigin(deps, ws)
  if (!origin) throw new Error(noDevServerReason(deps, ws))
  const url = urlFor(origin, path)

  // 빈 주소로 방송한다 — 탭만 열고 이동은 하지 말라는 뜻이다. 이동은 아래에서 메인이 한다.
  requestPreviewOpen(workspaceId, '')

  const guest = await waitForGuest(workspaceId)
  if (!guest) throw new Error(NO_PANEL)

  try {
    await load(guest, url)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    throw new Error(`Could not load ${url} — ${message}. ${noDevServerReason(deps, ws)}`, {
      cause: err
    })
  }

  return {
    url,
    result: `The preview is now showing ${url}.`,
    note: 'Take a screenshot with capture_preview; read console and network errors with read_preview_issues.'
  }
}

/** 로딩이 끝나기를 잠깐 기다린다. 안 끝나도 찍는다 — 중간 화면도 정보다. */
async function settle(guest: WebContents): Promise<void> {
  const deadline = Date.now() + SETTLE_WAIT_MS
  while (guest.isLoading() && Date.now() < deadline) await delay(POLL_MS)
}

export const capturePreview: AgentToolHandler = async (_deps, workspaceId) => {
  workspaceOf(workspaceId)
  const guest = previewGuestFor(workspaceId)
  if (!guest) throw new Error(NOT_OPEN)

  const url = guest.getURL()
  if (!url || url === 'about:blank') {
    throw new Error('The preview is open but has not loaded a page yet — call open_preview first.')
  }

  await settle(guest)
  const shot = await captureForAgent(guest)
  if ('error' in shot) throw new Error(shot.error)

  const { dataBase64, width, height, scaledFrom } = shot.capture
  return {
    url,
    width,
    height,
    ...(scaledFrom
      ? {
          scaledDown: true,
          note:
            `The screenshot was scaled down from ${scaledFrom.width}×${scaledFrom.height} to ` +
            'stay within the size Wooi returns to an agent. Fine detail may be lost.'
        }
      : {}),
    [AGENT_TOOL_IMAGE_KEY]: { dataBase64, mediaType: 'image/png' }
  }
}

/** 에러를 경고보다 앞에 둔다 — 잘릴 때 남아야 할 것이 에러다(formatIssues 와 같은 순서). */
function ordered(issues: readonly PreviewIssue[]): PreviewIssue[] {
  return [...issues].sort((a, b) => {
    if (a.level !== b.level) return a.level === 'error' ? -1 : 1
    return a.ts - b.ts
  })
}

export const readPreviewIssues: AgentToolHandler = async (_deps, workspaceId) => {
  const ws = workspaceOf(workspaceId)
  const guest = previewGuestFor(workspaceId)
  const all = previewIssues().list(workspaceId)

  const kept: Array<Omit<PreviewIssue, 'id' | 'ts'>> = []
  let bytes = 0
  for (const issue of ordered(all)) {
    if (kept.length >= MAX_ISSUES) break
    const entry = {
      level: issue.level,
      kind: issue.kind,
      text: issue.text,
      ...(issue.source ? { source: issue.source } : {}),
      count: issue.count
    }
    const size = Buffer.byteLength(JSON.stringify(entry), 'utf8')
    if (kept.length > 0 && bytes + size > MAX_ISSUE_BYTES) break
    bytes += size
    kept.push(entry)
  }

  return {
    url: guest?.getURL() || (ws.previewUrl ?? ''),
    previewOpen: !!guest,
    errors: all.filter((i) => i.level === 'error').length,
    warnings: all.filter((i) => i.level === 'warning').length,
    total: all.length,
    issues: kept,
    ...(kept.length < all.length ? { truncated: true } : {}),
    ...(all.length
      ? {}
      : {
          result: guest
            ? 'Nothing has been collected for the page the preview is showing. Wooi drops what it ' +
              'collected whenever the preview navigates, so this is the state since the last load.'
            : 'The preview is not open for this workspace, so nothing is being collected. ' +
              'Call open_preview first.'
        })
  }
}
