/* global process */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

export const E2E_WORKSPACE_DISPLAY_NAME = 'E2E workspace with a deliberately long name'

function exportedNumber(source, name, file) {
  const match = source.match(new RegExp(`export\\s+const\\s+${name}\\s*=\\s*(\\d+)`))
  if (!match) throw new Error(`${name} not found in ${file}`)
  return Number(match[1])
}

function requiredInterfaceFields(source, name, file) {
  const body = source.match(new RegExp(`export interface ${name}\\s*{([\\s\\S]*?)\\n}`))?.[1]
  if (!body) throw new Error(`${name} interface not found in ${file}`)
  const withoutComments = body.replace(/\/\*[\s\S]*?\*\//g, '')
  return [...withoutComments.matchAll(/^\s{2}([A-Za-z_$][\w$]*)(\?)?:/gm)]
    .filter((match) => !match[2])
    .map((match) => match[1])
}

/** 현재 앱 소스와 대조한 최소 상태를 격리된 userData에 쓴다. */
export async function seedAppState(
  { userDataPath, repoPath, worktrees },
  {
    appDir = process.cwd(),
    workspaceName = Object.keys(worktrees)[0],
    transcript = [],
    peerSent = [],
    // "물려받았다" 를 확인하는 스펙은 기본값과 **다른** 값에서 출발해야 한다 — 기본값 그대로면
    // 상속했는지 전역 기본을 다시 읽었는지 구별되지 않는다.
    workspace: workspaceOverrides = {}
  } = {}
) {
  const root = resolve(appDir)
  const schemaFile = join(root, 'src/main/storeSchema.ts')
  const typesFile = join(root, 'src/shared/types.ts')
  const [schemaSource, typesSource] = await Promise.all([
    readFile(schemaFile, 'utf8'),
    readFile(typesFile, 'utf8')
  ])
  const schemaVersion = exportedNumber(schemaSource, 'CURRENT_SCHEMA_VERSION', schemaFile)
  const termsVersion = exportedNumber(typesSource, 'CURRENT_TERMS_VERSION', typesFile)
  const requiredFields = requiredInterfaceFields(typesSource, 'Workspace', typesFile)
  const worktreePath = worktrees[workspaceName]
  if (!worktreePath) throw new Error(`worktree not found for ${workspaceName}`)

  const now = Date.now()
  const repo = {
    id: 'repo-e2e',
    name: 'e2e-repo',
    path: repoPath,
    defaultBranch: 'main',
    setupScript: '',
    runScripts: [],
    archiveScript: '',
    carryItems: [],
    addedAt: now
  }
  const seededWorkspace = {
    id: 'ws-e2e',
    repoId: repo.id,
    agentBackend: 'claude',
    name: workspaceName,
    displayName: E2E_WORKSPACE_DISPLAY_NAME,
    branch: workspaceName,
    baseBranch: 'main',
    parentWorkspaceId: null,
    createdByWorkspaceId: null,
    prNumber: null,
    worktreePath,
    ports: {},
    setupState: 'success',
    sessionId: transcript.length > 0 ? 'session-e2e-seeded' : null,
    permissionMode: 'default',
    status: 'idle',
    model: null,
    effort: null,
    fastMode: null,
    lastModel: null,
    fastModeState: null,
    fastModeReason: null,
    archived: false,
    createdAt: now,
    lastActiveAt: now,
    // 옵셔널 필드라 넘기지 않으면 아예 쓰지 않는다 — 마이그레이션 없이 읽히는 레코드를 그대로 둔다.
    ...(peerSent.length > 0 ? { peerSent } : {})
  }
  // 기본 시드가 다루지 않는 모드도 spec에서 만들 수 있도록 덮어쓰기를 허용한다.
  const workspace = { ...seededWorkspace, ...workspaceOverrides }
  const missing = requiredFields.filter((field) => !Object.hasOwn(workspace, field))
  if (missing.length > 0) {
    throw new Error(`e2e seed is missing required Workspace fields: ${missing.join(', ')}`)
  }

  const transcriptsDir = join(userDataPath, 'transcripts')
  await mkdir(transcriptsDir, { recursive: true })
  if (transcript.length > 0) {
    const body = transcript.map((item) => JSON.stringify(item)).join('\n') + '\n'
    await writeFile(join(transcriptsDir, `${workspace.id}.jsonl`), body)
  }
  await writeFile(
    join(userDataPath, 'wooi.json'),
    JSON.stringify(
      {
        schemaVersion,
        repos: [repo],
        workspaces: [workspace],
        fanoutGroups: [],
        reviews: [],
        settings: {
          onboarded: true,
          pickedDefaults: true,
          acceptedTermsVersion: termsVersion
        }
      },
      null,
      2
    )
  )
  return { repo, workspace, schemaVersion, requiredWorkspaceFieldCount: requiredFields.length }
}

/**
 * 메인 프로세스가 보내는 승인 요청 이벤트를 그대로 흉내 낸다.
 *
 * 모델 턴 없이 승인·질문 카드를 띄우는 유일한 길이다. 채널 이름은 소스에서 읽는다 — 여기에
 * 문자열을 박아 두면 IPC 상수가 바뀐 날 스펙은 조용히 아무것도 검사하지 않게 된다.
 */
export async function sendPermissionRequest(app, request, { appDir = process.cwd() } = {}) {
  const typesFile = join(resolve(appDir), 'src/shared/types.ts')
  const channel = (await readFile(typesFile, 'utf8')).match(/evtPermission:\s*'([^']+)'/)?.[1]
  if (!channel) throw new Error(`evtPermission channel not found in ${typesFile}`)
  await app.evaluate(
    ({ BrowserWindow }, payload) => {
      const win = BrowserWindow.getAllWindows()[0]
      if (!win) throw new Error('no window to deliver the permission request to')
      win.webContents.send(payload.channel, payload.request)
    },
    { channel, request }
  )
}

/** 시작 화면이 Overview든 자동 선택된 대화든 같은 워크스페이스 헤더까지 들어간다. */
export async function openSeededWorkspace(win) {
  const header = win.locator('.workspace-header')
  if ((await header.count()) === 0) {
    await win.locator(`[title="${E2E_WORKSPACE_DISPLAY_NAME}"]`).last().click()
  }
  await header.waitFor()
  return header
}

/**
 * 시드된 워크스페이스의 사이드바 행. 행 전체가 우클릭 대상이므로 안쪽 이름 스팬을 잡으면
 * 컨텍스트 메뉴가 열리지 않는다 — 그 차이를 스펙마다 다시 알아내지 않게 여기 둔다.
 */
export function seededWorkspaceRow(win) {
  return win.locator('[role="button"]').filter({ hasText: E2E_WORKSPACE_DISPLAY_NAME }).first()
}

/** 행 컨텍스트 메뉴를 열고 이름으로 항목을 돌려준다(비활성 항목도 남아 있으므로 그대로 잡힌다). */
export async function openRowMenuItem(win, name) {
  await seededWorkspaceRow(win).click({ button: 'right' })
  const item = win.getByRole('menuitem', { name })
  await item.waitFor()
  return item
}

/** 수동 PNG 확인이 필요할 때만 scratch 정리 전에 창을 유지한다. */
export async function waitForInspection(win) {
  const inspectMs = Number(process.env.WOOI_E2E_INSPECT_MS ?? 0)
  if (inspectMs > 0) await win.waitForTimeout(inspectMs)
}
