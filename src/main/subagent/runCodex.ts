import { detectCodex } from '../codex/executable'
import { codexEffort, execCodex } from '../codex/exec'
import { turnPolicyFor } from '../codex/modes'
import { createCodexReader } from '../review/runCodex'
import type { SubAgentRunDeps, SubAgentResult } from './run'

/**
 * Codex 로 위임 작업을 돌린다.
 *
 * 워크스페이스가 쓰는 `codex app-server`(codex/host.ts)를 재사용하지 않고 `codex exec` 를 띄운다 —
 * app-server 는 워크스페이스 하나당 스레드 하나를 전제로 승인·전달·트랜스크립트 지속과 얽혀 있고,
 * 위임은 워크스페이스가 없는 일회성 실행이라 그 기계장치가 통째로 걸리적거린다(리뷰가 같은 이유로
 * 같은 선택을 했다).
 *
 * ## 승인 UI 가 없다는 뜻
 *
 * `codex exec` 는 비대화형이라 승인 요청을 보낼 채널이 아예 없다. 그래서 이 경로에서는
 * **샌드박스가 유일한 방어선**이고, 그 정책을 부모 워크스페이스의 권한 모드에서 그대로 도출한다.
 * Claude 위임(runClaude.ts)이 부모의 권한 UI 로 물어보는 것과 대비되는 비대칭인데, 감추지 않고
 * 위임 도구 설명에 적어 모델과 사용자가 함께 알게 한다.
 */
export async function runCodexSubAgent(deps: SubAgentRunDeps): Promise<SubAgentResult> {
  const install = await detectCodex()
  if (!install.usable || !install.path) {
    return {
      text: '',
      sessionId: null,
      error: install.reason ?? 'The Codex CLI is not available.'
    }
  }

  // 부모 권한 모드 → 샌드박스. 워크스페이스와 같은 매핑을 쓰므로 "Read only 인데 파일이 써졌다"
  // 같은 어긋남이 생기지 않는다.
  const sandbox = turnPolicyFor(deps.permissionMode, deps.cwd).sandboxMode

  const args = ['exec', '-s', sandbox, '--json']
  // worktree 는 git 저장소 안이지만 판정을 codex 에 맡길 이유가 없다. 샌드박스가 이미 쓰기
  // 범위를 정하고 있으므로 이 확인은 신호가 아니라 잡음이다.
  args.push('--skip-git-repo-check')
  if (deps.model) args.push('-m', deps.model)
  const effort = codexEffort(deps.effort)
  if (effort) args.push('-c', `model_reasoning_effort="${effort}"`)
  // 프롬프트는 stdin 으로 — 이유는 codex/exec.ts 의 execCodex 주석 참고.
  args.push('-')

  // 구조화 출력을 요구하지 않으므로 아티팩트 파싱을 끈다. 켜 두면 JSON 으로 답한 서브런의
  // 최종 메시지가 리뷰 결과로 오인돼 결과 텍스트에서 통째로 사라진다.
  const reader = createCodexReader(
    (item) => {
      deps.onActivity({
        kind: item.kind === 'error' ? 'error' : item.kind === 'tool' ? 'tool' : 'text',
        text: item.text
      })
    },
    { parseArtifacts: false }
  )

  const outcome = await execCodex(install.path, args, deps.prompt, deps, reader)
  const run = reader.out

  // 중단은 실패가 아니다 — 부모 턴이 인터럽트된 것이므로 지금까지 모은 텍스트만 돌려준다.
  if (outcome.aborted) {
    return { text: run.rawText.trim(), sessionId: run.threadId, error: null }
  }

  const text = run.rawText.trim()
  return {
    text,
    sessionId: run.threadId,
    // 결과가 남았으면 종료 코드가 어떻든 건진다. 아무것도 없을 때만 실패로 본다.
    error: text ? null : (run.error ?? outcome.error)
  }
}
