import { describe, it, expect } from 'vitest'
import { asksForApproval, turnPolicyFor } from './modes'

/**
 * 권한 모드 → 실행 정책 변환은 **보안 경계**다. Ask for approval과 Approve for me는
 * 누가 승인하는지만 다르고 같은 workspace 경계를 써야 한다.
 */

const WORKTREE = '/tmp/wooi/worktree'

describe('turnPolicyFor', () => {
  it('Ask for approval — worktree 안은 쓰기 허용 + 경계 요청은 사용자 승인', () => {
    expect(turnPolicyFor('askForApproval', WORKTREE)).toEqual({
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [WORKTREE],
        networkAccess: false
      },
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'user'
    })
  })

  it('Approve for me — 같은 worktree 경계 + Auto-review', () => {
    expect(turnPolicyFor('default', WORKTREE)).toEqual({
      sandboxPolicy: {
        type: 'workspaceWrite',
        writableRoots: [WORKTREE],
        networkAccess: false
      },
      sandboxMode: 'workspace-write',
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review'
    })
  })

  it('Plan mode — 읽기 전용 샌드박스와 plan 협업 모드', () => {
    expect(turnPolicyFor('plan', WORKTREE)).toEqual({
      sandboxPolicy: { type: 'readOnly' },
      sandboxMode: 'read-only',
      approvalPolicy: 'never',
      approvalsReviewer: 'user',
      collaborationMode: 'plan'
    })
  })

  it('fullAccess — 샌드박스·승인 모두 해제', () => {
    expect(turnPolicyFor('fullAccess', WORKTREE)).toEqual({
      sandboxPolicy: { type: 'dangerFullAccess' },
      sandboxMode: 'danger-full-access',
      approvalPolicy: 'never',
      approvalsReviewer: 'user'
    })
  })

  // 워크스페이스 격리의 핵심 — 쓰기 루트가 worktree 밖으로 새면 다른 작업물을 건드릴 수 있다.
  it('쓰기 루트는 항상 그 워크스페이스의 worktree 로만 좁힌다', () => {
    const policy = turnPolicyFor('default', '/repos/alpha')
    expect(policy.sandboxPolicy).toMatchObject({ writableRoots: ['/repos/alpha'] })
  })

  // Claude 전용·이전 Codex 모드가 저장값에 남아 있을 수 있다.
  // 그때 조용히 넓은 권한으로 떨어지면 안 된다.
  it('Codex 가 모르는 모드는 기본(Auto)으로 보정한다 — 더 넓은 권한으로 열리지 않는다', () => {
    for (const foreign of ['acceptEdits', 'auto', 'readOnly'] as const) {
      const policy = turnPolicyFor(foreign, WORKTREE)
      expect(policy.sandboxPolicy.type).toBe('workspaceWrite')
      expect(policy.approvalPolicy).toBe('on-request')
    }
  })

  it('null/undefined 도 기본(Auto)으로 떨어진다', () => {
    expect(turnPolicyFor(null, WORKTREE).sandboxPolicy.type).toBe('workspaceWrite')
    expect(turnPolicyFor(undefined, WORKTREE).sandboxPolicy.type).toBe('workspaceWrite')
  })
})

// thread/start 는 문자열 모드만, turn/start 는 정책 객체만 받는다. 둘이 어긋나면 스레드 기준선과
// 실제 턴 정책이 달라져 추적하기 어려운 권한 사고가 난다.
describe('sandboxMode 와 sandboxPolicy 의 일관성', () => {
  const EQUIV: Record<string, string> = {
    readOnly: 'read-only',
    workspaceWrite: 'workspace-write',
    dangerFullAccess: 'danger-full-access'
  }
  it('모든 모드에서 두 표현이 같은 것을 가리킨다', () => {
    for (const mode of ['askForApproval', 'default', 'plan', 'fullAccess'] as const) {
      const p = turnPolicyFor(mode, WORKTREE)
      expect(p.sandboxMode).toBe(EQUIV[p.sandboxPolicy.type])
    }
  })
})

describe('asksForApproval', () => {
  it('fullAccess 와 읽기 전용 Plan 모드는 승인을 요구하지 않는다', () => {
    expect(asksForApproval('fullAccess')).toBe(false)
    expect(asksForApproval('plan')).toBe(false)
    for (const mode of ['askForApproval', 'default'] as const) {
      expect(asksForApproval(mode)).toBe(true)
    }
  })
})
