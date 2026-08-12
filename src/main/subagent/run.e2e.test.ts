import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { runSubAgent, type SubAgentActivity } from './run'

/**
 * 실제 CLI 를 상대로 위임 실행의 끝에서 끝까지를 확인한다.
 *
 * 유닛 테스트는 우리가 이해한 대로의 계약만 고정한다 — 인자 조립이 틀렸거나(`codex exec` 의
 * 플래그 조합) JSONL 필드 이름이 바뀌면 전부 통과하면서도 실물에서는 아무 텍스트도 못 받는다.
 * 그 간극은 이 테스트만 잡는다.
 *
 * **기본적으로 건너뛴다.** 다른 e2e(appServer)와 달리 이 경로는 모델을 실제로 호출하므로
 * 자격증명과 토큰을 쓴다. CI 나 평범한 `vitest run` 에서 돌면 안 된다.
 *
 *   WOOI_E2E_AGENTS=1 npx vitest run src/main/subagent/run.e2e.test.ts
 */

function installed(cli: string): boolean {
  try {
    const shell = process.env.SHELL || '/bin/zsh'
    return Boolean(execFileSync(shell, ['-lc', `command -v ${cli}`], { encoding: 'utf8' }).trim())
  } catch {
    return false
  }
}

const ENABLED = process.env.WOOI_E2E_AGENTS === '1'

describe.skipIf(!ENABLED)('위임 실행 (실제 CLI)', () => {
  it.skipIf(!installed('codex'))(
    'Codex 위임이 최종 텍스트를 돌려준다',
    async () => {
      const activities: SubAgentActivity[] = []
      const result = await runSubAgent({
        backend: 'codex',
        cwd: process.cwd(),
        repoPath: process.cwd(),
        model: null,
        effort: 'low',
        // 읽기 전용 샌드박스로 — 이 테스트가 저장소를 건드릴 이유가 없다.
        permissionMode: 'readOnly',
        prompt: 'Reply with exactly the word BANANA and nothing else. Do not use any tools.',
        abort: new AbortController(),
        onActivity: (a) => activities.push(a)
      })

      expect(result.error).toBeNull()
      // 최종 메시지가 rawText 로 나와야 한다. parseArtifacts 를 끄지 않았다면 여기서 빈 문자열이 된다.
      expect(result.text).toContain('BANANA')
      // thread id 가 없으면 JSONL 의 thread.started 를 놓친 것이다.
      expect(result.sessionId).toBeTruthy()
    },
    180_000
  )

  it.skipIf(!installed('claude'))(
    'Claude 위임이 도구를 쓰고 최종 텍스트를 돌려준다',
    async () => {
      const asked: string[] = []
      const result = await runSubAgent({
        backend: 'claude',
        cwd: process.cwd(),
        repoPath: process.cwd(),
        // 가장 싼 모델로 고정한다 — 여기서 확인하는 것은 배선이지 모델 품질이 아니다.
        model: 'claude-haiku-4-5',
        effort: null,
        permissionMode: 'default',
        prompt: 'Read package.json and reply with only the value of the "name" field.',
        abort: new AbortController(),
        onActivity: () => {},
        canUseTool: async (toolName, input) => {
          asked.push(toolName)
          return { behavior: 'allow', updatedInput: input }
        }
      })

      expect(result.error).toBeNull()
      expect(result.text).toContain('wooi')
      // canUseTool 이 한 번도 안 불릴 수 있다(Read 는 default 모드에서 CLI 가 스스로 통과시킨다).
      // 그래서 호출 횟수가 아니라 "물어봤다면 우리가 아는 도구였는가"만 본다.
      expect(asked.every((name) => typeof name === 'string' && name.length > 0)).toBe(true)
    },
    180_000
  )

  it.skipIf(!installed('copilot'))(
    'Copilot(ACP) 위임이 매달리지 않고 결과를 돌려준다',
    async () => {
      const activities: SubAgentActivity[] = []
      const result = await runSubAgent({
        backend: 'copilot',
        cwd: process.cwd(),
        repoPath: process.cwd(),
        // ACP v1 은 모델 선택 경로가 없다(runAcp.ts 참고). 값을 줘도 무시되는 것이 정상이다.
        model: 'ignored-by-acp',
        effort: 'low',
        // 읽기 전용으로 — 이 테스트가 저장소를 건드릴 이유가 없다.
        permissionMode: 'readOnly',
        prompt: 'Reply with exactly the word BANANA and nothing else. Do not use any tools.',
        abort: new AbortController(),
        onActivity: (a) => activities.push(a),
        canUseTool: async (_toolName, input) => ({ behavior: 'allow', updatedInput: input })
      })

      // 여기서 고정하는 것은 모델의 답이 아니라 **배선**이다: 핸드셰이크 → session/new →
      // session/prompt → stop 이 실제로 끝까지 돈다는 것. 계정 정책이 모델 호출을 막아도
      // (조직 정책으로 Copilot CLI 가 잠긴 계정이 있다) 서버는 그 사실을 텍스트로 돌려주므로,
      // 이 테스트는 "매달리지 않고 사람이 읽을 것이 남는다" 를 본다.
      expect(result.sessionId).toBeTruthy()
      expect(result.text || result.error).toBeTruthy()
      // 활동은 도구를 쓰지 않는 프롬프트라 0건일 수 있다. 개수가 아니라 모양만 본다 —
      // toolName 이 비어 오면 사이드바가 빈 줄을 그린다.
      expect(activities.every((a) => a.kind !== 'tool' || Boolean(a.toolName))).toBe(true)
    },
    180_000
  )
})
