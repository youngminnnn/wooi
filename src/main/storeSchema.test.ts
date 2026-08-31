import { describe, it, expect } from 'vitest'
import { CURRENT_SCHEMA_VERSION, DEFAULT_SETTINGS, migrate, normalizeShape } from './storeSchema'
import type { AgentSettings, AppSettings, Repo, Workspace } from '@shared/types'

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

describe('current defaults', () => {
  it('rate-limit 자동 재개는 명시적으로 켜기 전까지 꺼져 있다', () => {
    expect(DEFAULT_SETTINGS.autoResumeAfterRateLimit).toBe(false)
    expect(DEFAULT_SETTINGS.autoResolveConflicts).toBe(false)
  })

  it('모델 폴백은 Claude 에만 소비되고 Codex 기본 동작은 빈 목록으로 남는다', () => {
    expect(DEFAULT_SETTINGS.agents.claude.fallbackModels).toEqual([])
    expect(DEFAULT_SETTINGS.agents.codex.fallbackModels).toEqual([])
  })
})

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
    // 뒤 버전이 필드를 더하는 것까지 막을 이유는 없다(v19 의 createdByWorkspaceId). 이 테스트가
    // 지키는 것은 v12 가 들고 있던 값이 그대로 남는가이므로 부분 일치로 본다.
    expect(out.workspaces).toMatchObject(v12File().workspaces as object[])
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

/** v21 이후 PR 단위 상태는 layers 안에 있다. 옛 마이그레이션 테스트가 공유해 쓴다. */
function layerOf(review: Record<string, unknown>): Record<string, unknown> {
  return (review.layers as Record<string, unknown>[])[0]
}

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
  // (v21 에서 PR 단위 필드가 layers 로 접혔으므로 그 안을 본다.)
  it('작성자를 모르는 리뷰는 자기 PR 로 단정하지 않는다', () => {
    const layer = layerOf(reviewsOf(migrate(v14File(), 14))[0])
    expect(layer.prAuthor).toBe('')
    expect(layer.viewerIsAuthor).toBe(false)
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
    expect(layerOf(reviewOf(migrate(v15File(), 15))).lastSubmission).toBeNull()
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
    expect(layerOf(reviewOf(out)).lastSubmission).toEqual({
      verdict: 'request-changes',
      at: 1700000000000
    })
  })

  it('제출한 적 없는 리뷰는 그대로 둔다', () => {
    expect(layerOf(reviewOf(migrate(v16File(null), 16))).lastSubmission).toBeNull()
  })

  it('리뷰가 없는 파일도 그대로 통과한다', () => {
    const out = migrate({ schemaVersion: 16, repos: [], workspaces: [] }, 16)
    expect(out.reviews).toEqual([])
  })
})

describe('v17 → v18 (리뷰가 자기 모델·강도를 갖는다)', () => {
  function v17File(review: Record<string, unknown>): Record<string, unknown> {
    return { schemaVersion: 17, repos: [], workspaces: [], reviews: [review] }
  }

  const reviewOf = (out: Record<string, unknown>): Record<string, unknown> =>
    (out.reviews as Record<string, unknown>[])[0]

  /** 옛 리뷰가 무엇으로 돌았는지는 알 길이 없다 — 비워 두면 후속 턴이 전역 기본값으로 떨어진다. */
  it('옛 리뷰는 모델·강도를 비운 채로 채운다', () => {
    const out = migrate(v17File({ id: 'rv1', repoId: 'r1', prNumber: 3 }), 17)
    expect(reviewOf(out)).toMatchObject({ model: null, effort: null })
  })

  it('이미 골라 둔 값은 덮어쓰지 않는다', () => {
    const out = migrate(
      v17File({ id: 'rv1', repoId: 'r1', prNumber: 3, model: 'gpt-5-codex', effort: 'high' }),
      17
    )
    expect(reviewOf(out)).toMatchObject({ model: 'gpt-5-codex', effort: 'high' })
  })

  it('리뷰가 없는 파일도 그대로 통과한다', () => {
    expect(migrate({ schemaVersion: 17, repos: [], workspaces: [] }, 17).reviews).toEqual([])
  })
})

describe('v18 → v19 (워크스페이스 생성자 기록)', () => {
  const v18File = (): Record<string, unknown> => ({
    schemaVersion: 18,
    repos: [],
    workspaces: [
      { id: 'w1', repoId: 'r1', name: 'alpha', parentWorkspaceId: null },
      { id: 'w2', repoId: 'r1', name: 'beta', parentWorkspaceId: 'w1' }
    ]
  })

  // 부모가 있다고 그 부모의 에이전트가 만든 것은 아니다(사람이 UI 에서 만든 스택이 그렇다).
  // 여기서 추측하면 에이전트가 사람의 워크스페이스를 지울 권한을 소급해 얻는다.
  it('부모가 있어도 생성자를 추측하지 않고 전부 null 로 둔다', () => {
    const workspaces = migrate(v18File(), 18).workspaces as Partial<Workspace>[]

    expect(workspaces.map((w) => w.createdByWorkspaceId)).toEqual([null, null])
    // 부모 관계 자체는 그대로여야 한다 — 두 필드는 서로 다른 질문에 답한다.
    expect(workspaces[1].parentWorkspaceId).toBe('w1')
  })

  it('워크스페이스가 없는 파일도 그대로 통과한다', () => {
    expect(migrate({ schemaVersion: 18, repos: [], workspaces: [] }, 18).workspaces).toEqual([])
  })
})

describe('v19 → v20 (다중 run script)', () => {
  it('리포별 dev 명령 id에 맞춰 여러 워크스페이스의 포트를 보존한다', () => {
    const out = migrate(
      {
        schemaVersion: 19,
        repos: [
          { id: 'r1', devScript: 'npm run dev' },
          { id: 'r2', devScript: 'pnpm web' },
          { id: 'r3', devScript: '' }
        ],
        workspaces: [
          { id: 'w1', repoId: 'r1', devPort: 3100 },
          { id: 'w2', repoId: 'r1', devPort: null },
          { id: 'w3', repoId: 'r2', devPort: 3102 },
          { id: 'w4', repoId: 'r3', devPort: 3103 }
        ]
      },
      19
    )
    const repos = out.repos as Repo[]
    const workspaces = out.workspaces as Workspace[]
    const r1 = repos[0].runScripts[0]
    const r2 = repos[1].runScripts[0]

    expect(r1).toMatchObject({ name: 'Dev', command: 'npm run dev', autoStart: false })
    expect(r2.id).not.toBe(r1.id)
    expect(repos[2].runScripts).toEqual([])
    expect(workspaces[0].ports).toEqual({ [r1.id]: 3100 })
    expect(workspaces[1].ports).toEqual({})
    expect(workspaces[2].ports).toEqual({ [r2.id]: 3102 })
    expect(workspaces[3].ports).toEqual({})
    expect(out).not.toHaveProperty('devScript')
    expect(workspaces.every((w) => !('devPort' in w))).toBe(true)
  })
})

describe('v20 → v21 (fan-out 그룹)', () => {
  it('기존 워크스페이스를 그룹으로 묶어 추측하지 않는다', () => {
    // 나란히 만들어졌다는 이유로 묶으면, 사용자가 만든 적 없는 "채택" 대상이 생긴다 —
    // 그리고 채택은 형제를 아카이브하는 동작이다.
    const out = migrate(
      {
        schemaVersion: 20,
        repos: [{ id: 'r1' }],
        workspaces: [
          { id: 'w1', repoId: 'r1', name: 'alpha' },
          { id: 'w2', repoId: 'r1', name: 'alpha-2' }
        ]
      },
      20
    )
    expect(out.fanoutGroups).toEqual([])
    expect((out.workspaces as Workspace[]).map((w) => w.id)).toEqual(['w1', 'w2'])
  })
})

describe('v22 → v23 (폐기된 Codex 모델 정리)', () => {
  const v22File = (): Record<string, unknown> => ({
    schemaVersion: 22,
    repos: [],
    workspaces: [
      { id: 'c1', agentBackend: 'codex', model: 'gpt-5.4' },
      { id: 'c2', agentBackend: 'codex', model: 'gpt-5.4-mini' },
      { id: 'c3', agentBackend: 'codex', model: 'gpt-5.4-codex' },
      { id: 'c4', agentBackend: 'codex', model: 'gpt-5-codex' },
      { id: 'c5', agentBackend: 'codex', model: null },
      { id: 'a1', agentBackend: 'claude', model: 'gpt-5.4' }
    ]
  })

  it('Codex 의 gpt-5.4 계열만 카탈로그 기본값(null)으로 비운다', () => {
    const workspaces = migrate(v22File(), 22).workspaces as Partial<Workspace>[]
    expect(workspaces.map((workspace) => workspace.model)).toEqual([
      null,
      null,
      null,
      'gpt-5-codex',
      null,
      'gpt-5.4'
    ])
  })
})

describe('v23 → v24 (미확인 워크스페이스 영속)', () => {
  it('기존 파일은 미확인 목록을 추측하지 않고 빈 배열로 시작한다', () => {
    const out = migrate({ schemaVersion: 23, repos: [], workspaces: [] }, 23)
    expect(out.unreadWorkspaceIds).toEqual([])
  })
})

describe('v24 → v25 (힌트 스위치 도입)', () => {
  const v24File = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    schemaVersion: 24,
    repos: [],
    workspaces: [],
    settings: {
      onboarded: true,
      pickedDefaults: true,
      acceptedTermsVersion: 1
    },
    ...overrides
  })

  it('showHints 를 기본 켜짐으로 채운다', () => {
    const out = migrate(v24File(), 24)
    expect(settingsOf(out).showHints).toBe(true)
  })

  // v5 → v6 은 의도치 않게 onboarded 를 초기화했었다 — 그 사고를 반복하지 않기 위한 가드다.
  it('기존 온보딩 상태를 건드리지 않는다', () => {
    const out = migrate(v24File(), 24)
    const settings = settingsOf(out)
    expect(settings.onboarded).toBe(true)
    expect(settings.pickedDefaults).toBe(true)
    expect(settings.acceptedTermsVersion).toBe(1)
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
    expect(ws.ports).toBeDefined()
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

  it('이미 변환된 파일에 v12 변환이 다시 돌아도 agents 를 덮어쓰지 않는다', () => {
    // 예전 store 는 마이그레이션 뒤에도 파일의 schemaVersion 을 올리지 않아 이 상황이 실제로
    // 났다 — 매 부팅마다 v12→v13 이 다시 돌며 사용자의 권한 모드를 acceptEdits 로 되돌렸다.
    const already = migrate(v12File(), 12)
    const again = migrate({ ...already, schemaVersion: 12 }, 12)
    expect(agentsOf(again).claude).toEqual(agentsOf(already).claude)
    expect(agentsOf(again).claude.permissionMode).toBe('plan')
  })

  it('사용자가 고른 권한 모드는 재변환에도 살아남는다', () => {
    const migrated = migrate(v12File(), 12)
    const settings = migrated.settings as AppSettings
    settings.agents = {
      ...settings.agents,
      claude: { ...settings.agents.claude, permissionMode: 'auto' }
    }

    const again = migrate({ ...migrated, schemaVersion: 12 }, 12)
    expect(agentsOf(again).claude.permissionMode).toBe('auto')
  })
})

/**
 * 마이그레이션이 못 메우는 구멍을 막는 안전망. 실제로 터진 적이 있다 — `schemaVersion` 이 이미
 * 20 인 `Wooi (dev)` 파일에 v20 이전 빌드가 워크스페이스를 이어서 쓰자(브랜치를 오가며
 * `npm run dev` 하면 나는 상황) `ports` 없는 레코드가 남았고, 그 뒤로 워크스페이스를 만들 때마다
 * `Object.values(w.ports)` 가 "Cannot convert undefined or null to object" 로 터졌다.
 */
describe('normalizeShape (구버전 빌드가 남긴 레코드 메우기)', () => {
  it('ports 없는 워크스페이스에 빈 레코드를 채운다', () => {
    const out = normalizeShape({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      repos: [],
      workspaces: [{ id: 'w1', name: 'old', devPort: 3100 }]
    })
    expect((out.workspaces as Workspace[])[0].ports).toEqual({})
  })

  it('savedPrompts 는 없으면 그대로 두고, 배열이 아니면 지운다', () => {
    // 옵셔널 필드라 빈 배열로 메우지 않는다 — 메우면 스키마 버전을 올리지 않는 이유가 사라진다.
    const untouched = normalizeShape({ repos: [{ id: 'r1', runScripts: [] }] })
    expect('savedPrompts' in (untouched.repos as Repo[])[0]).toBe(false)
    const kept = normalizeShape({
      repos: [{ id: 'r1', runScripts: [], savedPrompts: [{ id: 'p1', name: 'R', prompt: 'go' }] }]
    })
    expect((kept.repos as Repo[])[0].savedPrompts).toHaveLength(1)
    // 배열이 아닌 값은 지운다. 그대로 두면 목록을 그냥 순회하는 화면들이 통째로 멈춘다.
    const cleaned = normalizeShape({
      repos: [{ id: 'r1', runScripts: [], savedPrompts: 'nope' }]
    })
    expect('savedPrompts' in (cleaned.repos as Repo[])[0]).toBe(false)
  })

  it('runScripts 없는 리포에 빈 배열을 채운다', () => {
    const out = normalizeShape({ repos: [{ id: 'r1', name: 'demo' }], workspaces: [] })
    expect((out.repos as Repo[])[0].runScripts).toEqual([])
  })

  it('이미 있는 값은 건드리지 않는다 — 다운그레이드 상황에서 덮으면 데이터가 손상된다', () => {
    const out = normalizeShape({
      repos: [{ id: 'r1', runScripts: [{ id: 's1', name: 'Dev', command: 'npm run dev' }] }],
      workspaces: [{ id: 'w1', ports: { s1: 3100 } }]
    })
    expect((out.repos as Repo[])[0].runScripts).toHaveLength(1)
    expect((out.workspaces as Workspace[])[0].ports).toEqual({ s1: 3100 })
  })

  it('repos·workspaces·fanoutGroups 자체가 없어도 빈 배열로 돌려준다', () => {
    expect(normalizeShape({ schemaVersion: CURRENT_SCHEMA_VERSION })).toEqual({
      schemaVersion: CURRENT_SCHEMA_VERSION,
      reviews: [],
      repos: [],
      workspaces: [],
      unreadWorkspaceIds: [],
      fanoutGroups: []
    })
  })

  it('미확인 목록이 없는 최신 버전 파일도 빈 배열로 메운다', () => {
    expect(normalizeShape({ repos: [], workspaces: [] }).unreadWorkspaceIds).toEqual([])
  })

  it('이미 있는 fan-out 그룹은 그대로 둔다', () => {
    // v21 이전 빌드가 최신 버전 파일에 이어서 쓰면 이 배열이 통째로 사라진다. 없으면 채우되,
    // 있는 것을 비우면 사용자가 만든 묶음이 조용히 사라지므로 값은 건드리지 않는다.
    const groups = [{ id: 'g1', workspaceIds: ['w1', 'w2'] }]
    expect(normalizeShape({ fanoutGroups: groups }).fanoutGroups).toEqual(groups)
  })

  it('마이그레이션을 건너뛰는 최신 버전 파일에도 적용된다', () => {
    const raw = { schemaVersion: CURRENT_SCHEMA_VERSION, repos: [], workspaces: [{ id: 'w1' }] }
    const out = normalizeShape(migrate(raw, CURRENT_SCHEMA_VERSION))
    expect((out.workspaces as Workspace[])[0].ports).toEqual({})
  })
})
