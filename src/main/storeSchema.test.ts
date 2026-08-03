import { describe, it, expect } from 'vitest'
import { CURRENT_SCHEMA_VERSION, DEFAULT_SETTINGS, migrate } from './storeSchema'
import type { AgentSettings, AppSettings, Workspace } from '@shared/types'

/**
 * 마이그레이션은 **사용자의 실제 데이터를 변환**하는 코드다 — 회귀가 나면 설정·워크스페이스가
 * 통째로 날아가거나 조용히 엉뚱한 값이 된다. 그래서 각 단계의 계약을 픽스처로 못 박아 둔다.
 */

/** v12 시점(에이전트 = Claude 하나)의 저장 파일. v13 변환의 입력. */
function v12File(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 12,
    repos: [{ id: 'r1', name: 'demo', path: '/tmp/demo', defaultBranch: 'main' }],
    workspaces: [
      {
        id: 'w1',
        repoId: 'r1',
        agentBackend: 'claude',
        name: 'alpha',
        permissionMode: 'acceptEdits',
        model: 'claude-sonnet-5',
        effort: 'high',
        sessionId: 'sess-1',
        status: 'idle'
      }
    ],
    settings: {
      defaultPermissionMode: 'plan',
      model: 'claude-opus-4-8',
      effort: 'xhigh',
      fastMode: true,
      theme: 'light',
      autoCompact: false,
      onboarded: true,
      acceptedTermsVersion: 1
    },
    ...overrides
  }
}

const settingsOf = (out: Record<string, unknown>): AppSettings => out.settings as AppSettings
const agentsOf = (out: Record<string, unknown>): Record<string, AgentSettings> =>
  settingsOf(out).agents

describe('v12 → v13 (백엔드별 에이전트 설정 분리)', () => {
  it('전역 모델·effort·권한 모드를 agents.claude 로 옮긴다', () => {
    const out = migrate(v12File(), 12)
    expect(agentsOf(out).claude).toEqual({
      model: 'claude-opus-4-8',
      effort: 'xhigh',
      permissionMode: 'plan',
      fastMode: true
    })
  })

  it('Codex 는 "백엔드 기본을 따름"(null)으로 시드한다', () => {
    const out = migrate(v12File(), 12)
    expect(agentsOf(out).codex).toEqual({
      model: null,
      effort: null,
      permissionMode: null,
      fastMode: false
    })
  })

  it('전역 단일 필드는 더 이상 남기지 않는다', () => {
    const out = migrate(v12File(), 12)
    const settings = settingsOf(out) as unknown as Record<string, unknown>
    expect(settings.defaultPermissionMode).toBeUndefined()
    expect(settings.model).toBeUndefined()
    expect(settings.effort).toBeUndefined()
    expect(settings.fastMode).toBeUndefined()
  })

  it('에이전트와 무관한 설정은 그대로 보존한다', () => {
    const out = migrate(v12File(), 12)
    const settings = settingsOf(out)
    expect(settings.theme).toBe('light')
    expect(settings.autoCompact).toBe(false)
    expect(settings.acceptedTermsVersion).toBe(1)
  })

  // 백엔드가 하나 늘었다는 이유로 이미 쓰고 있던 사용자를 다시 온보딩시키면 안 된다.
  // (v5 → v6 은 의도적으로 onboarded 를 초기화했었다 — 그 실수를 반복하지 않기 위한 가드다.)
  it('기존 사용자를 다시 온보딩시키지 않는다', () => {
    const out = migrate(v12File(), 12)
    expect(settingsOf(out).onboarded).toBe(true)
  })

  it('워크스페이스는 건드리지 않는다(백엔드·모델·모드 모양이 그대로다)', () => {
    const out = migrate(v12File(), 12)
    expect(out.workspaces).toEqual(v12File().workspaces)
  })

  it('설정이 비어 있어도 안전한 기본값을 만든다', () => {
    const out = migrate({ schemaVersion: 12, repos: [], workspaces: [] }, 12)
    expect(agentsOf(out).claude.model).toBe(DEFAULT_SETTINGS.agents.claude.model)
    expect(agentsOf(out).codex).toEqual({
      model: null,
      effort: null,
      permissionMode: null,
      fastMode: false
    })
  })
})

describe('v14 → v15 (리뷰의 에이전트 · PR 작성자)', () => {
  /** v14 시점의 리뷰 레코드. 그 시절 리뷰는 전부 Claude 로 돌았고 작성자를 몰랐다. */
  function v14File(): Record<string, unknown> {
    return {
      schemaVersion: 14,
      repos: [],
      workspaces: [],
      reviews: [{ id: 'rv1', repoId: 'r1', prNumber: 3, status: 'done', archived: false }]
    }
  }

  const reviewsOf = (out: Record<string, unknown>): Record<string, unknown>[] =>
    out.reviews as Record<string, unknown>[]

  it('기존 리뷰를 claude 로 채운다', () => {
    expect(reviewsOf(migrate(v14File(), 14))[0].agentBackend).toBe('claude')
  })

  // 작성자를 모를 때 자기 PR 로 단정하면 정상적인 승인까지 막힌다 — 모르면 막지 않는 쪽이다.
  it('작성자를 모르는 리뷰는 자기 PR 로 단정하지 않는다', () => {
    const review = reviewsOf(migrate(v14File(), 14))[0]
    expect(review.prAuthor).toBe('')
    expect(review.viewerIsAuthor).toBe(false)
  })

  it('리뷰가 없는 파일도 그대로 통과한다', () => {
    const out = migrate({ schemaVersion: 14, repos: [], workspaces: [] }, 14)
    expect(out.reviews).toEqual([])
  })
})

describe('v15 → v16 (제출 기록 합치기)', () => {
  /** v15 시점의 리뷰 레코드 — 판정만 알고 본문도 그때의 sha 도 모른다. */
  function v15File(): Record<string, unknown> {
    return {
      schemaVersion: 15,
      repos: [],
      workspaces: [],
      reviews: [
        {
          id: 'rv1',
          repoId: 'r1',
          prNumber: 3,
          status: 'done',
          archived: false,
          lastVerdict: 'approve',
          lastVerdictAt: 1700000000000
        }
      ]
    }
  }

  const reviewOf = (out: Record<string, unknown>): Record<string, unknown> =>
    (out.reviews as Record<string, unknown>[])[0]

  it('옛 판정은 옮기지 않고 비운다', () => {
    expect(reviewOf(migrate(v15File(), 15)).lastSubmission).toBeNull()
  })

  it('합쳐진 옛 필드는 남기지 않는다', () => {
    const review = reviewOf(migrate(v15File(), 15))
    expect(review).not.toHaveProperty('lastVerdict')
    expect(review).not.toHaveProperty('lastVerdictAt')
  })

  it('리뷰가 없는 파일도 그대로 통과한다', () => {
    const out = migrate({ schemaVersion: 15, repos: [], workspaces: [] }, 15)
    expect(out.reviews).toEqual([])
  })
})

describe('v16 → v17 (제출 기록에서 본문 빼기)', () => {
  function v16File(lastSubmission: unknown): Record<string, unknown> {
    return {
      schemaVersion: 16,
      repos: [],
      workspaces: [],
      reviews: [{ id: 'rv1', repoId: 'r1', prNumber: 3, status: 'done', lastSubmission }]
    }
  }

  const reviewOf = (out: Record<string, unknown>): Record<string, unknown> =>
    (out.reviews as Record<string, unknown>[])[0]

  it('본문과 head sha 를 버리고 판정만 남긴다', () => {
    const out = migrate(
      v16File({
        verdict: 'request-changes',
        body: 'Please fix the retry loop.',
        headSha: 'abc1234',
        at: 1700000000000
      }),
      16
    )
    expect(reviewOf(out).lastSubmission).toEqual({
      verdict: 'request-changes',
      at: 1700000000000
    })
  })

  it('제출한 적 없는 리뷰는 그대로 둔다', () => {
    expect(reviewOf(migrate(v16File(null), 16)).lastSubmission).toBeNull()
  })

  it('리뷰가 없는 파일도 그대로 통과한다', () => {
    const out = migrate({ schemaVersion: 16, repos: [], workspaces: [] }, 16)
    expect(out.reviews).toEqual([])
  })
})

describe('레거시 파일 전체 경로', () => {
  it('v0(버전 필드 없음) 파일을 현재 스키마까지 끝까지 변환한다', () => {
    const legacy = {
      repos: [{ id: 'r1', name: 'demo', path: '/tmp/demo', defaultBranch: 'main' }],
      workspaces: [{ id: 'w1', repoId: 'r1', name: 'alpha', permissionMode: 'bypassPermissions' }],
      settings: { model: 'claude-opus-5' }
    }
    const out = migrate(legacy, 0)
    const ws = (out.workspaces as Partial<Workspace>[])[0]

    // v0 → v1: 더 이상 노출하지 않는 모드는 acceptEdits 로 환산된다.
    expect(ws.permissionMode).toBe('acceptEdits')
    // v2 → v3: dev 포트가 배정된다.
    expect(typeof ws.devPort).toBe('number')
    // v4 → v5: 백엔드 식별자가 채워진다.
    expect(ws.agentBackend).toBe('claude')
    // v8 → v9: 스택 필드가 초기화된다.
    expect(ws.parentWorkspaceId).toBeNull()
    // v9 → v10: opus-5 는 1M 윈도를 잡는 `[1m]` 접미사로 승격된다. 그 값이 v11 에서
    // agents.claude 로 넘어갔는지까지 확인한다(단계 간 연결이 끊기면 여기서 잡힌다).
    expect(agentsOf(out).claude.model).toBe('claude-opus-5[1m]')
  })

  it('미래 버전 파일은 손대지 않는다', () => {
    const future = { schemaVersion: CURRENT_SCHEMA_VERSION + 5, repos: [], workspaces: [] }
    expect(migrate(future, CURRENT_SCHEMA_VERSION + 5)).toEqual(future)
  })
})
