import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ReviewProgressItem } from '@shared/types'
import { runCopilotReview } from './runCopilot'
import type { ReviewRunDeps } from './run'

/**
 * Copilot 리뷰를 실제 CLI 로 끝에서 끝까지 확인한다.
 *
 * 이 경로에만 있는 위험 때문에 e2e 가 필요하다. Claude·Codex 는 CLI 가 JSON 스키마를 **강제**
 * 하지만(`outputFormat` · `--output-schema`) ACP 에는 그런 자리가 없어, 우리는 스키마를 프롬프트
 * 꼬리에 실어 부탁하고 펜스 파싱으로 회수한다. 그 부탁이 실제로 먹히는지는 모델을 돌려 봐야만
 * 알 수 있고, 유닛 테스트는 전부 통과하면서도 실물에서는 아티팩트가 하나도 안 나올 수 있다.
 *
 * **기본적으로 건너뛴다.** 모델을 실제로 호출해 자격증명과 토큰을 쓴다([[subagent/run.e2e]] 규약).
 *
 *   WOOI_E2E_AGENTS=1 npx vitest run src/main/review/runCopilot.e2e.test.ts
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

/** 리뷰어가 반드시 지적할 만한 한 줄짜리 변경. 짧을수록 턴이 빨리 끝난다. */
function scratchRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wooi-copilot-review-'))
  writeFileSync(join(dir, 'math.js'), 'export const div = (a, b) => a / b\n')
  return dir
}

function deps(cwd: string, onProgress: (item: ReviewProgressItem) => void): ReviewRunDeps {
  return {
    backend: 'copilot',
    cwd,
    repoPath: cwd,
    model: null,
    effort: null,
    userPrompt: '',
    meta: {
      layers: [
        {
          number: 1,
          title: 'Add div()',
          baseRefName: 'main',
          headRefName: 'feat/div',
          headSha: 'deadbeef',
          localRef: 'refs/wooi/head',
          baseRef: 'refs/wooi/base'
        }
      ]
    },
    diffs: [
      {
        prNumber: 1,
        diff: {
          files: [
            {
              path: 'math.js',
              oldPath: null,
              status: 'added',
              additions: 1,
              deletions: 0,
              binary: false,
              hunks: [
                {
                  header: '@@ -0,0 +1 @@',
                  rows: [
                    {
                      kind: 'add',
                      text: 'export const div = (a, b) => a / b',
                      oldLine: null,
                      newLine: 1
                    }
                  ]
                }
              ]
            }
          ]
        }
      }
    ],
    abort: new AbortController(),
    onProgress
  }
}

describe.skipIf(!ENABLED)('Copilot 리뷰 (실제 CLI)', () => {
  it.skipIf(!installed('copilot'))(
    '스키마를 프롬프트로 부탁해 구조화 결과를 받아 온다',
    async () => {
      const progress: ReviewProgressItem[] = []
      const cwd = scratchRepo()
      const result = await runCopilotReview(
        deps(cwd, (item) => progress.push(item)),
        'Review this one-line change. Keep it very short — one finding is enough.'
      )

      expect(result.error).toBeNull()
      // 이어 묻기(session/load)의 열쇠. 없으면 후속 턴이 맥락 없이 새로 시작한다.
      expect(result.sessionId).toBeTruthy()
      // 이것이 이 테스트의 존재 이유다 — 스키마 강제가 없는데도 아티팩트가 나오는가.
      expect(result.artifact).not.toBeNull()
      expect(typeof result.artifact?.summary).toBe('string')
    },
    240_000
  )

  it.skipIf(!installed('copilot'))(
    '중단하면 오류 없이 조용히 끝난다',
    async () => {
      const cwd = scratchRepo()
      const d = deps(cwd, () => {})
      const run = runCopilotReview(d, 'Write a very long and detailed review of this change.')
      setTimeout(() => d.abort.abort(), 3_000)
      const result = await run

      // 사용자가 끊은 것은 실패가 아니다 — 카드에 빨간 오류가 뜨면 안 된다.
      expect(result.error).toBeNull()
    },
    120_000
  )
})
