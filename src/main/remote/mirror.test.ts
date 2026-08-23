import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppState, PermissionMode, PermissionRequest, Repo, Workspace } from '@shared/types'
import type { RemoteMachine, RemoteState } from '@shared/remote'
import type { RemoteKeystore } from './keystore'

vi.mock('electron', () => ({
  app: { getPath: () => '/unused', getVersion: () => '1.0.0' },
  safeStorage: { isEncryptionAvailable: () => true }
}))

const { deriveDirectionKeys, fromBase64Url, generateSessionKey, openJson, toBase64Url } =
  await import('@shared/crypto')
const { backendMeta } = await import('../agent/backend')
const {
  MIRROR_DEBOUNCE_MS,
  StateMirror,
  actsWithoutAsking,
  projectPermissionModeFooter,
  projectPlanUsage,
  projectPr,
  projectRateLimit,
  projectState,
  projectStatusLine
} = await import('./mirror')
const { rememberCompacting, rememberContextUsage, forgetContextUsage } =
  await import('../contextUsageCache')
const { rememberModels } = await import('../modelCatalog')

const machine: RemoteMachine = { id: 'machine-1', name: 'Mac', appVersion: '1.2.3' }
const sessionKey = generateSessionKey()
const device = {
  deviceId: 'device-1',
  name: 'Phone',
  platform: 'ios' as const,
  sessionKey: toBase64Url(sessionKey),
  createdAt: 1
}

interface PublishedRow {
  machine_id: string
  device_id: string
  rev: number
  // **문자열이다.** bytea 컬럼은 `\x` + hex 를 받는다. 여기 타입을 Uint8Array 로 두었더니
  // 왕복 테스트가 와이어 형식을 건너뛰어, 실제로는 깨져 있던 인코딩을 통과시켰다.
  nonce: string
  state_ct: string
  updated_at: string
}

let rows: PublishedRow[]
let upsert: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  rows = []
  upsert = vi.fn(async (published: PublishedRow[]) => {
    rows.push(...published)
    return { error: null }
  })
})

afterEach(() => {
  vi.useRealTimers()
})

function appState(statuses: Workspace['status'][] = ['idle']): AppState {
  const repo = {
    id: 'repo-1',
    name: 'Wooi',
    path: '/Users/private/Wooi',
    defaultBranch: 'main',
    setupScript: 'npm install secret',
    runScripts: [{ id: 'dev', name: 'Dev', command: 'npm run dev secret' }],
    archiveScript: 'destroy secret',
    carryItems: [{ path: '.env.secret', mode: 'copy' }],
    avatarDataUrl: 'data:image/png;base64,secret',
    addedAt: 1,
    devScript: 'legacy secret'
  } as Repo & { devScript: string }
  const workspaces = statuses.map(
    (status, index) =>
      ({
        id: `ws-${index + 1}`,
        repoId: repo.id,
        name: `workspace-${index + 1}`,
        displayName: null,
        autoName: 'Automatic name',
        branch: `feat/${index + 1}`,
        worktreePath: `/Users/private/worktree-${index + 1}`,
        permissionMode: 'default',
        status,
        model: null,
        effort: null,
        archived: false,
        muted: false,
        prNumber: null,
        lastActiveAt: index + 10,
        carryItems: [{ path: '.workspace-secret', mode: 'copy' }]
      }) as Workspace & { carryItems: Array<{ path: string; mode: 'copy' }> }
  )
  return {
    repos: [repo],
    workspaces,
    fanoutGroups: [],
    reviews: [],
    settings: {} as AppState['settings']
  }
}

function permission(workspaceId: string): PermissionRequest {
  return { requestId: `request-${workspaceId}`, workspaceId, toolName: 'Bash', input: {} }
}

function mirror(startRev: number | null = 0): InstanceType<typeof StateMirror> {
  const client = {
    from: vi.fn(() => ({ upsert }))
  } as unknown as SupabaseClient
  const keystore = {
    listDevices: () => [device]
  } as unknown as RemoteKeystore
  return new StateMirror({
    startRev: startRev ?? undefined,
    supabase: () => client,
    keystore,
    machine: () => machine
  })
}

async function flush(): Promise<void> {
  await vi.advanceTimersByTimeAsync(MIRROR_DEBOUNCE_MS)
}

describe('projectState', () => {
  it('민감하거나 큰 데스크톱 필드를 중첩 위치에서도 내보내지 않는다', () => {
    const projection = projectState(appState(), machine, [])
    const json = JSON.stringify(projection)
    for (const field of [
      'worktreePath',
      'avatarDataUrl',
      'setupScript',
      'devScript',
      'archiveScript',
      'carryItems'
    ]) {
      expect(json).not.toContain(field)
    }
  })

  it('권한 요청, 오류, 정상 상태 순으로 attention을 파생한다', () => {
    const projection = projectState(appState(['error', 'error', 'idle']), machine, [
      permission('ws-1')
    ])
    expect(projection.workspaces.map((workspace) => workspace.attention)).toEqual([
      'permission',
      'error',
      null
    ])
  })

  it('렌더러가 올린 미확인 목록만 unread 로 실린다', () => {
    const projection = projectState(
      appState(['idle', 'idle', 'idle']),
      machine,
      [],
      new Set(['ws-2'])
    )
    expect(projection.workspaces.map((workspace) => workspace.unread)).toEqual([false, true, false])
  })

  it('미확인 목록을 주지 않으면 아무것도 미확인이 아니다 — 모르는 것을 칠하지 않는다', () => {
    const projection = projectState(appState(['idle', 'idle']), machine, [])
    expect(projection.workspaces.every((workspace) => workspace.unread === false)).toBe(true)
  })

  it('워크스페이스별 권한 attention과 요청 본문을 함께 투영한다', () => {
    const pending = permission('ws-1')
    const projection = projectState(appState(['idle', 'idle']), machine, [pending])

    expect(projection.workspaces[0]?.attention).toBe('permission')
    expect(projection.workspaces[1]?.attention).toBeNull()
    expect(projection.pendingPermissions).toEqual([pending])
    expect(projection.workspaces[0].autoName).toBe('Automatic name')
  })
})

describe('projectPlanUsage', () => {
  const snapshot = (
    values: Partial<AppState['rateLimits'] & object> = {}
  ): NonNullable<AppState['rateLimits']> => ({
    fetchedAt: 1_700_000_000_000,
    available: true,
    subscriptionType: 'max',
    windows: [{ label: '5-hour', utilization: 41.6, resetsAt: '2023-11-14T23:30:00.000Z' }],
    ...values
  })

  it('사용률을 0–100 정수로, 리셋 시각을 epoch ms 로 정규화한다', () => {
    const app = { ...appState(), rateLimitsByAgent: { claude: snapshot() } }
    expect(projectPlanUsage(app)).toEqual([
      {
        agent: 'claude',
        agentLabel: backendMeta('claude').label,
        plan: 'max',
        fetchedAt: 1_700_000_000_000,
        windows: [
          { label: '5-hour', usedPct: 42, resetsAt: Date.parse('2023-11-14T23:30:00.000Z') }
        ]
      }
    ])
  })

  it('요금제 한도가 적용되지 않는 계정은 싣지 않는다', () => {
    const app = {
      ...appState(),
      rateLimitsByAgent: { claude: snapshot({ available: false, subscriptionType: null }) }
    }
    expect(projectPlanUsage(app)).toEqual([])
  })

  it('사용률을 모르는 창은 빼고, 남는 창이 없으면 계정 자체를 빼며, 못 읽는 리셋 시각은 null 로 둔다', () => {
    const app = {
      ...appState(),
      rateLimitsByAgent: {
        claude: snapshot({
          windows: [
            { label: '5-hour', utilization: null, resetsAt: null },
            { label: 'Weekly', utilization: 12, resetsAt: 'not-a-date' }
          ]
        }),
        codex: snapshot({ windows: [{ label: 'Weekly', utilization: null, resetsAt: null }] })
      }
    }
    const usage = projectPlanUsage(app)
    expect(usage.map((item) => item.agent)).toEqual(['claude'])
    expect(usage[0]?.windows).toEqual([{ label: 'Weekly', usedPct: 12, resetsAt: null }])
  })

  it('백엔드별 필드가 없는 예전 상태에서는 단일 스냅샷을 Claude 것으로 읽는다', () => {
    const app = { ...appState(), rateLimits: snapshot() }
    expect(projectPlanUsage(app).map((item) => item.agent)).toEqual(['claude'])
  })

  it('보여 줄 것이 없어도 필드 자체는 빈 배열로 실어 보낸다', () => {
    expect(projectState(appState(), machine, []).planUsage).toEqual([])
  })
})

describe('projectStatusLine', () => {
  afterEach(() => {
    forgetContextUsage('ws-1')
  })

  const settings = {
    agents: { claude: { model: 'claude-sonnet-5', effort: 'high' } }
  } as unknown as AppState['settings']

  function base(): Parameters<typeof projectStatusLine>[0] {
    return {
      id: 'ws-1',
      agentBackend: 'claude',
      model: null,
      lastModel: null,
      effort: null
    } as Parameters<typeof projectStatusLine>[0]
  }

  it('오버라이드 → lastModel → 전역 기본값 순으로 유효 값을 고른다', () => {
    rememberModels('claude', [
      { id: 'claude-opus-5[1m]', label: 'Opus 5 (1M context)' },
      { id: 'claude-sonnet-5', label: 'Sonnet 5 (1M context)' }
    ])

    expect(projectStatusLine({ ...base(), model: 'claude-opus-5[1m]' }, settings).model).toBe(
      'Opus 5 (1M context)'
    )
    expect(projectStatusLine({ ...base(), lastModel: 'claude-opus-5[1m]' }, settings).model).toBe(
      'Opus 5 (1M context)'
    )
    // 아무 오버라이드도 없으면 그 백엔드의 전역 기본값이 유효 값이다.
    expect(projectStatusLine(base(), settings).model).toBe('Sonnet 5 (1M context)')
  })

  it('effort 라벨은 백엔드 서술자에서 뽑고, 지정이 없으면 전역 기본값을 쓴다', () => {
    const high = backendMeta('claude').efforts.find((e) => e.id === 'high')?.label
    expect(projectStatusLine(base(), settings).effort).toBe(high)
    expect(projectStatusLine({ ...base(), effort: 'low' }, settings).effort).toBe(
      backendMeta('claude').efforts.find((e) => e.id === 'low')?.label
    )
  })

  it('첫 턴 전에는 컨텍스트를 null 로 둔다 — 0% 는 "맥락이 비었다"는 다른 말이다', () => {
    expect(projectStatusLine(base(), settings).context).toBeNull()
  })

  it('캐시에 적힌 사용량과 압축 진행 상태를 그대로 싣는다', () => {
    rememberContextUsage('ws-1', { usedTokens: 120, maxTokens: 1000, percentage: 0.12 })
    rememberCompacting('ws-1', true)

    const line = projectStatusLine(base(), settings)
    expect(line.context).toEqual({ usedTokens: 120, maxTokens: 1000, percentage: 0.12 })
    expect(line.compacting).toBe(true)
  })

  it('윈도 크기를 모르면 게이지를 그릴 수 없으므로 사용량을 싣지 않는다', () => {
    rememberContextUsage('ws-1', { usedTokens: 120, maxTokens: 0, percentage: 0 })
    expect(projectStatusLine(base(), settings).context).toBeNull()
  })

  // 폰이 실제로 읽는 것은 투영 전체다. 함수만 맞고 projectState 가 싣지 않으면 화면에서는
  // 그 줄이 통째로 사라지는데(옵셔널 필드라 타입은 통과한다), 실기기에서 정확히 그렇게 겪었다.
  it('projectState 가 워크스페이스마다 statusLine 을 싣는다', () => {
    const projection = projectState(appState(['idle', 'running']), machine, [])
    expect(projection.workspaces).toHaveLength(2)
    for (const workspace of projection.workspaces) {
      expect(workspace.statusLine).toEqual({
        model: expect.any(String),
        effort: expect.any(String),
        context: null,
        compacting: false
      })
    }
  })
})

describe('StateMirror', () => {
  it('성공한 투영과 같으면 두 번째 upsert를 생략하고 바뀌면 다시 게시한다', async () => {
    const stateMirror = mirror()
    const app = appState()
    stateMirror.publish(app, [])
    await flush()
    stateMirror.publish(app, [])
    await flush()
    expect(upsert).toHaveBeenCalledTimes(1)

    app.workspaces[0].status = 'running'
    stateMirror.publish(app, [])
    await flush()
    expect(upsert).toHaveBeenCalledTimes(2)
  })

  it('짧은 변경 버스트를 마지막 상태 한 번으로 합친다', async () => {
    const stateMirror = mirror()
    const app = appState()
    stateMirror.publish(app, [])
    app.workspaces[0].status = 'running'
    stateMirror.publish(app, [])
    app.workspaces[0].status = 'error'
    stateMirror.publish(app, [])
    await flush()
    expect(upsert).toHaveBeenCalledTimes(1)
  })

  it('dispose가 대기 중인 게시를 취소한다', async () => {
    const stateMirror = mirror()
    stateMirror.publish(appState(), [])
    stateMirror.dispose()
    await flush()
    expect(upsert).not.toHaveBeenCalled()
  })

  it('PR 을 아직 모르는 것과 PR 이 없는 것을 구분한다', async () => {
    // 모르는 것을 "없음"으로 단정하면 폰이 그동안 idle 색을 칠했다가 나중에 색이 튀어나온다.
    const { forgetPrStatus, rememberPrStatus } = await import('../prStatusCache')

    forgetPrStatus('ws-unknown')
    expect(projectPr('ws-unknown')).toBeUndefined()

    rememberPrStatus('ws-none', null)
    expect(projectPr('ws-none')).toBeNull()

    rememberPrStatus('ws-open', {
      number: 12,
      url: 'https://example/pr/12',
      title: 'Fix login',
      state: 'approved',
      label: 'Ready to merge',
      needsBaseUpdate: false
    })
    // 제목은 싣는다 — 사용자 지정 이름이 없는 워크스페이스의 **표시 이름**이 PR 제목이라,
    // 빼면 같은 워크스페이스가 랩탑에서는 'Fix login', 폰에서는 worktree 이름으로 갈린다.
    // URL 도 싣는다 — 폰의 PR 화면이 랩탑이 자는 동안에도 브라우저로 넘어갈 수 있어야 한다.
    expect(projectPr('ws-open')).toEqual({
      number: 12,
      state: 'approved',
      label: 'Ready to merge',
      title: 'Fix login',
      url: 'https://example/pr/12',
      needsBaseUpdate: false
    })
  })

  it('권한 모드 표시는 백엔드의 서술자에서 뽑는다', () => {
    // 같은 id 가 백엔드마다 다른 뜻이다. Claude 의 'default' 는 매번 묻는 모드라 띄울 것이
    // 없고, Codex 의 'default' 는 워크스페이스 안에서 자동으로 도는 모드라 그렇게 말해야 한다.
    expect(projectPermissionModeFooter('claude', 'default')).toBeNull()
    // **문구는 단언하지 않는다.** 그건 서술자의 것이고 상류에서 종종 바뀐다(Codex 의
    // 'default' 는 'auto mode on' → 'auto-review on' → 'approve for me on' 으로 바뀌었다).
    // 여기서 지킬 불변식은 "지어내지 않고 서술자에서 그대로 가져온다" 이므로 서술자와
    // 대조한다. 문구를 박아 두면 카피가 바뀔 때마다 결함 없이 빨개진다.
    const footerOf = (backend: 'claude' | 'codex', mode: PermissionMode) =>
      backendMeta(backend).permissionModes.find((item) => item.id === mode)?.footer ?? null

    expect(projectPermissionModeFooter('codex', 'default')).toEqual({
      ...footerOf('codex', 'default'),
      tone: 'caution'
    })
    expect(projectPermissionModeFooter('claude', 'plan')).toEqual({
      ...footerOf('claude', 'plan'),
      tone: 'readOnly'
    })
    // 스스로 실행하는 모드는 전부 같은 무게(경고)로 보여야 한다 — 이쪽이 진짜 불변식이다.
    expect(projectPermissionModeFooter('claude', 'acceptEdits')?.tone).toBe('caution')
    expect(projectPermissionModeFooter('codex', 'fullAccess')?.tone).toBe('caution')
    // 그 백엔드에 없는 모드는 띄우지 않는다 — 지어내는 것보다 비우는 편이 정직하다.
    // (Codex 는 모드 구성이 여러 번 바뀌었다. 지금은 plan·readOnly 가 없다.)
    expect(projectPermissionModeFooter('codex', 'readOnly')).toBeNull()
    // 그 백엔드에 없는 모드는 띄우지 않는다 — 지어내는 것보다 비우는 편이 정직하다.
    expect(projectPermissionModeFooter('claude', 'fullAccess')).toBeNull()
  })

  it('사용량 제한은 재개 예약을 먼저 말한다', () => {
    // 사용자가 알아야 할 것은 "언제 다시 시작하는가"다. 그게 없을 때에야 "멈춰 있고 내가
    // 다시 눌러야 한다"가 된다 — 순서가 뒤집히면 기다리면 되는 상황에 사람을 부른다.
    expect(
      projectRateLimit({ pendingRateLimitResume: { retryAt: 42 }, rateLimited: { resetsAt: 7 } })
    ).toEqual({ kind: 'resuming', at: 42 })
    expect(projectRateLimit({ rateLimited: { resetsAt: 7 } })).toEqual({ kind: 'paused', at: 7 })
    // 해제 시각을 모를 수 있다 — 그래도 멈춰 있다는 사실은 전한다.
    expect(projectRateLimit({ rateLimited: {} })).toEqual({ kind: 'paused', at: null })
    expect(projectRateLimit({})).toBeNull()
  })

  it('묻지 않고 실행하는 모드를 폰이 알 수 있게 싣는다', () => {
    // 모드 이름은 백엔드마다 뜻이 다르다. 폰은 백엔드를 모르므로 여기서 판단해 보내야 한다.
    expect(actsWithoutAsking('claude', 'default')).toBe(false)
    expect(actsWithoutAsking('codex', 'default')).toBe(true)
    // 읽기 전용은 실행 자체가 없다.
    expect(actsWithoutAsking('claude', 'plan')).toBe(false)
    expect(actsWithoutAsking('codex', 'readOnly')).toBe(false)
    // 이름과 달리 워크스페이스 안에서는 묻지 않는다 — "밖으로 나갈 때만" 묻는 모드다.
    expect(actsWithoutAsking('codex', 'askForApproval')).toBe(true)
    // 편집이 그대로 적용되거나, 승인이 자동이거나, 아예 없다.
    expect(actsWithoutAsking('claude', 'acceptEdits')).toBe(true)
    expect(actsWithoutAsking('claude', 'auto')).toBe(true)
    expect(actsWithoutAsking('codex', 'fullAccess')).toBe(true)
  })

  it('rev 가 앱 재시작을 넘어 커진다 — 0 부터 다시 세지 않는다', async () => {
    // 폰은 뒤로 가는 rev 를 "옛날 상태"로 보고 버린다. 카운터가 프로세스마다 0 부터
    // 시작하면 재시작 이후의 모든 상태가 조용히 버려지고, 새 권한 요청이 폰에 뜨지 않는다.
    // 실기기에서 정확히 그렇게 멈췄다 — 그래서 기본 시작점은 벽시계다.
    const before = Date.now()
    const stateMirror = mirror(null)
    stateMirror.publish(appState(), [])
    await flush()
    expect(rows[0].rev).toBeGreaterThan(before)
  })

  it('폰 방향 키로 게시물을 실제 복호화할 수 있다', async () => {
    const stateMirror = mirror()
    const app = appState()
    const projection = projectState(app, machine, [])
    stateMirror.publish(app, [])
    await flush()

    const row = rows[0]
    const header = {
      v: 1,
      machineId: machine.id,
      deviceId: device.deviceId,
      kind: 'state' as const
    }
    const { laptopToPhone } = deriveDirectionKeys(fromBase64Url(device.sessionKey), device.deviceId)
    // 폰이 하는 것과 **똑같이** 문자열에서 바이트로 되돌린 뒤에 연다. 이 한 줄이
    // "Uint8Array 를 그대로 넘겨도 통과하던" 구멍을 막는다.
    const opened = openJson(laptopToPhone, header, {
      nonce: fromPgBytea(row.nonce),
      ct: fromPgBytea(row.state_ct)
    })
    expect(opened).toEqual({ ...projection, rev: 1 } satisfies RemoteState)
  })
})

/** PostgREST 가 돌려주는 `\x…` 를 바이트로. 폰의 decodePostgresBytea 와 같은 규칙이다. */
function fromPgBytea(value: string): Uint8Array {
  expect(value.startsWith('\\x')).toBe(true)
  const hex = value.slice(2)
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

describe('bytea 와이어 형식', () => {
  it('nonce·state_ct 를 \\x hex 문자열로 쓴다', async () => {
    // Uint8Array 를 그대로 넘기면 supabase-js 가 `{"0":1,…}` 객체로 직렬화하고
    // Postgres 가 그 문자들을 저장해 24바이트 nonce 가 ~193바이트가 된다.
    const m = mirror()
    m.publishNow(appState(), [])
    await vi.waitFor(() => expect(upsert).toHaveBeenCalled())
    const row = (upsert.mock.calls[0]![0] as PublishedRow[])[0]!
    expect(typeof row.nonce).toBe('string')
    expect(row.nonce).toMatch(/^\\x[0-9a-f]+$/)
    expect(fromPgBytea(row.nonce).length).toBe(24)
    m.dispose()
  })
})

describe('다중 기기', () => {
  it('기기마다 자기 키로 봉인해 자기 행에 올린다', async () => {
    // 한 행을 공유하면 나중에 봉인한 쪽이 앞 기기가 열 수 없는 암호문으로 덮어쓴다.
    // 그래서 0006 이 PK 를 (machine_id, device_id) 로 넓혔고, 여기서 그 계약을 고정한다.
    const second = {
      deviceId: '99999999-9999-9999-9999-999999999999',
      name: 'second phone',
      platform: 'android' as const,
      sessionKey: toBase64Url(generateSessionKey()),
      createdAt: 0
    }
    const client = { from: vi.fn(() => ({ upsert })) } as unknown as SupabaseClient
    const keystore = { listDevices: () => [device, second] } as unknown as RemoteKeystore
    const m = new StateMirror({
      startRev: 0,
      supabase: () => client,
      keystore,
      machine: () => machine
    })

    m.publishNow(appState(), [])
    await vi.waitFor(() => expect(rows.length).toBe(2))
    expect(rows.map((r) => r.device_id).sort()).toEqual([device.deviceId, second.deviceId].sort())

    // 각 기기가 **자기 키로만** 열 수 있어야 한다.
    for (const d of [device, second]) {
      const row = rows.find((r) => r.device_id === d.deviceId)!
      const header = { v: 1, machineId: machine.id, deviceId: d.deviceId, kind: 'state' } as const
      const { laptopToPhone } = deriveDirectionKeys(fromBase64Url(d.sessionKey), d.deviceId)
      const opened = openJson(laptopToPhone, header, {
        nonce: fromPgBytea(row.nonce),
        ct: fromPgBytea(row.state_ct)
      }) as { machine: { id: string } }
      expect(opened.machine.id).toBe(machine.id)

      // 남의 키로는 열리지 않는다.
      const other = d === device ? second : device
      const otherKeys = deriveDirectionKeys(fromBase64Url(other.sessionKey), other.deviceId)
      expect(() =>
        openJson(otherKeys.laptopToPhone, header, {
          nonce: fromPgBytea(row.nonce),
          ct: fromPgBytea(row.state_ct)
        })
      ).toThrow()
    }
    m.dispose()
  })
})
