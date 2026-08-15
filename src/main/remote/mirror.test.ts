import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AppState, PermissionRequest, Repo, Workspace } from '@shared/types'
import type { RemoteMachine, RemoteState } from '@shared/remote'
import type { RemoteKeystore } from './keystore'

vi.mock('electron', () => ({
  app: { getPath: () => '/unused', getVersion: () => '1.0.0' },
  safeStorage: { isEncryptionAvailable: () => true }
}))

const { deriveDirectionKeys, fromBase64Url, generateSessionKey, openJson, toBase64Url } =
  await import('@shared/crypto')
const { MIRROR_DEBOUNCE_MS, StateMirror, projectState } = await import('./mirror')

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

function mirror(): InstanceType<typeof StateMirror> {
  const client = {
    from: vi.fn(() => ({ upsert }))
  } as unknown as SupabaseClient
  const keystore = {
    listDevices: () => [device]
  } as unknown as RemoteKeystore
  return new StateMirror({ supabase: () => client, keystore, machine: () => machine })
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

  it('워크스페이스별 권한 attention과 요청 본문을 함께 투영한다', () => {
    const pending = permission('ws-1')
    const projection = projectState(appState(['idle', 'idle']), machine, [pending])

    expect(projection.workspaces[0]?.attention).toBe('permission')
    expect(projection.workspaces[1]?.attention).toBeNull()
    expect(projection.pendingPermissions).toEqual([pending])
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
    const m = new StateMirror({ supabase: () => client, keystore, machine: () => machine })

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
