import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC, type PermissionRequest } from '@shared/types'

vi.mock('electron', () => ({
  app: { getPath: () => '/unused', getVersion: () => '1.0.0' },
  safeStorage: { isEncryptionAvailable: () => true }
}))

const { validateRemoteCommand } = await import('./allowlist')
const { PENDING_PERMISSION_LIMIT, PENDING_PERMISSION_MAX_AGE_MS, PendingPermissionRegistry } =
  await import('./permissions')

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
