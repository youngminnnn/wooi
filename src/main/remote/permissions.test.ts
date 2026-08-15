import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC, type PermissionRequest } from '@shared/types'

vi.mock('electron', () => ({
  app: { getPath: () => '/unused', getVersion: () => '1.0.0' },
  safeStorage: { isEncryptionAvailable: () => true }
}))

const { validateRemoteCommand } = await import('./allowlist')
const {
  PENDING_PERMISSION_LIMIT,
  PENDING_PERMISSION_MAX_AGE_MS,
  PendingPermissionRegistry,
  pendingPermissions,
  resolveRemotePermission,
  setPermissionChangeNotifier
} = await import('./permissions')

let now: number
let registry: InstanceType<typeof PendingPermissionRegistry>

function request(requestId: string, toolName = 'Bash'): PermissionRequest {
  return { requestId, workspaceId: 'workspace-1', toolName, input: {} }
}

beforeEach(() => {
  now = 1_000_000
  registry = new PendingPermissionRegistry(() => now)
})

describe('PendingPermissionRegistry', () => {
  it('추가·목록·도구 조회·삭제를 왕복한다', () => {
    const first = request('first')
    const second = request('second', 'AskUserQuestion')
    registry.add(first)
    registry.add(second)

    expect(registry.list()).toEqual([first, second])
    expect(registry.toolFor('second')).toBe('AskUserQuestion')

    registry.remove('first')
    expect(registry.list()).toEqual([second])
    expect(registry.toolFor('first')).toBeUndefined()

    registry.clear()
    expect(registry.list()).toEqual([])
  })

  it('없는 요청 삭제는 아무 일도 하지 않는다', () => {
    const pending = request('pending')
    registry.add(pending)
    expect(() => registry.remove('unknown')).not.toThrow()
    expect(registry.list()).toEqual([pending])
  })

  it('가장 오래된 요청부터 버려 개수 상한을 지킨다', () => {
    for (let i = 0; i <= PENDING_PERMISSION_LIMIT; i += 1) {
      registry.add(request(`request-${i}`))
      now += 1
    }

    expect(registry.list()).toHaveLength(PENDING_PERMISSION_LIMIT)
    expect(registry.toolFor('request-0')).toBeUndefined()
    expect(registry.toolFor(`request-${PENDING_PERMISSION_LIMIT}`)).toBe('Bash')
  })

  it('30분이 지난 요청을 조회 시 제거한다', () => {
    registry.add(request('expired'))
    now += PENDING_PERMISSION_MAX_AGE_MS + 1

    expect(registry.list()).toEqual([])
    expect(registry.toolFor('expired')).toBeUndefined()
  })

  it('삭제된 요청의 updatedInput은 실제 허용목록에서도 거부한다', () => {
    registry.add(request('question', 'AskUserQuestion'))
    registry.remove('question')

    expect(() =>
      validateRemoteCommand(
        IPC.permissionRespond,
        ['question', { behavior: 'allow', updatedInput: { answers: { Q: 'A' } } }],
        { pendingPermissionTool: (requestId) => registry.toolFor(requestId) }
      )
    ).toThrow(/AskUserQuestion/)
  })
})

describe('응답한 요청의 정리', () => {
  it('resolveRemotePermission 이 목록에서 지우고 알림을 부른다', () => {
    // 취소에는 evt:permissionCancel 이 있지만 **응답에는 이벤트가 없다.** 이 경로가 없으면
    // 답한 뒤에도 요청이 대기 목록에 남아 폰이 영원히 "응답 대기 중"을 보여 준다 —
    // 실기기에서 정확히 그렇게 멈췄다.
    const notified: number[] = []
    setPermissionChangeNotifier(() => notified.push(1))
    pendingPermissions.clear()
    pendingPermissions.add({ requestId: 'r1', workspaceId: 'ws', toolName: 'Write', input: {} })

    resolveRemotePermission('r1')
    expect(pendingPermissions.list()).toHaveLength(0)
    expect(notified).toHaveLength(1)

    // 대기 중이 아니던 id 는 알림을 만들지 않는다(중복 방송을 하지 않는다).
    resolveRemotePermission('r1')
    expect(notified).toHaveLength(1)
    setPermissionChangeNotifier(null)
  })
})
