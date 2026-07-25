import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Claude CLI 가 세션 맥락을 보관하는 위치를 들여다보는 헬퍼.
 *
 * CLI 는 대화 맥락을 `~/.claude/projects/<cwd 슬러그>/<sessionId>.jsonl` 에 남긴다 — **계정
 * 정보는 전혀 들어 있지 않고** cwd 와 sessionId 로만 키가 잡힌다(자격증명은 Keychain/
 * ~/.claude.json 쪽에 따로 있다). 그래서 계정을 바꿔도 같은 sessionId 로 resume 하면 대화가
 * 그대로 이어진다 — 터미널에서 `claude --resume <id>` 가 로그인 계정과 무관하게 동작하는 이유다.
 *
 * Wooi 도 같은 전제를 따른다: **프로세스는 일회용이고, sessionId 는 함부로 버리지 않는다.**
 */

const PROJECTS_ROOT = join(homedir(), '.claude', 'projects')

/** cwd → CLI 의 프로젝트 디렉토리 이름(경로 구분자를 '-' 로 바꾼 슬러그). */
function slugFor(cwd: string): string {
  return cwd.replace(/\//g, '-')
}

/**
 * resume 대상 세션의 트랜스크립트가 디스크에 아직 있는지 확인한다.
 *
 * "resume 이 실패했으니 세션이 사라졌다" 고 단정하고 맥락을 버리기 전에 쓰는 안전장치다.
 * 인증 만료·네트워크 오류·계정 전환처럼 세션과 무관한 이유로 시작이 실패한 경우에 대화 맥락을
 * 잃지 않게 한다(과거에는 첫 메시지 전 모든 예외가 맥락 폐기로 이어졌다).
 *
 * 슬러그 규칙은 CLI 내부 구현이라 특수문자 처리가 바뀔 수 있으므로, 예상 경로에 없으면 프로젝트
 * 디렉토리 전체를 한 번 훑어 같은 sessionId 파일을 찾는다(실패 경로에서만 도는 저렴한 스캔).
 * 판정 자체가 불가능하면(디렉토리를 못 읽음) '있다'로 보아 보수적으로 맥락을 지킨다.
 */
export function sessionTranscriptExists(cwd: string, sessionId: string): boolean {
  // sessionId 는 CLI 가 발급한 UUID 다. 경로 조작 문자가 섞여 있으면 경로 계산을 하지 않는다.
  if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) return true

  const file = `${sessionId}.jsonl`
  if (existsSync(join(PROJECTS_ROOT, slugFor(cwd), file))) return true
  try {
    return readdirSync(PROJECTS_ROOT).some((dir) => existsSync(join(PROJECTS_ROOT, dir, file)))
  } catch {
    return true
  }
}
