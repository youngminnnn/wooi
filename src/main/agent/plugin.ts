import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { log } from '../logger'
import { WOOI_COMMANDS, WOOI_COMMAND_NAMESPACE, type WooiCommandSpec } from '@shared/wooiCommands'

/**
 * `/wooi:*` 슬래시 명령을 Claude Code 에 넘기는 **로컬 플러그인**을 디스크에 만든다.
 *
 * 왜 우리가 직접 목록을 관리하지 않고 플러그인을 쓰나: 플러그인 이름이 그대로 명령 접두사가
 * 되므로(`.claude-plugin/plugin.json` 의 name → `/wooi:pr`) 사용자의 개인 명령과 겹치지 않고,
 * CLI 가 명령을 자기 목록에 실어 주므로 `supportedCommands()` 를 읽는 자동완성이 공짜로 뜬다
 * ([[claude/commands]] 에 이름을 하드코딩할 필요가 없다). 확장도 CLI 가 한다 — 사용자가
 * `/wooi:pr` 을 평범한 메시지로 보내면 CLI 가 아래 본문으로 바꿔 모델에게 준다.
 *
 * `skipMcpDiscovery` 와 짝을 이룬다(session.ts) — 이 플러그인은 명령만 싣고, `wooi` MCP 서버는
 * 우리가 인프로세스로 직접 띄운다. 그 플래그가 없으면 CLI 가 플러그인 쪽 MCP 설정을 따로 찾는다.
 *
 * Codex 는 같은 포맷을 읽지만(바이너리가 `.claude-plugin/plugin.json`·`commands/` 를 파싱한다)
 * 슬래시 확장이 TUI 크레이트에만 있고 Wooi 가 쓰는 app-server 에는 그 RPC 가 없다. 그래서
 * Codex 워크스페이스에서는 이 파일이 아니라 Wooi 가 직접 확장한다([[codex/manager]]).
 */

/**
 * 플러그인을 풀어 두는 곳.
 *
 * 앱 리소스가 아니라 userData 아래인 이유: 이 디렉토리를 읽는 것은 우리가 아니라 **claude CLI
 * 자식 프로세스**다. 패키징하면 앱 리소스는 app.asar 안에 들어가는데 asar 는 디렉토리가 아니라
 * 파일이라 외부 프로세스가 그 안을 열 수 없다 — resolveClaudeExecutable 이 네이티브 바이너리에서
 * 겪은 것과 같은 실패다. 부팅 때 카탈로그에서 생성하면 SSOT 는 TypeScript 에 남고 asar 문제도 없다.
 *
 * electron `app` 을 쓰지 않는 이유: 이 경로는 메인(생성)과 agent-host 유틸리티 프로세스(세션
 * 옵션에 전달) 양쪽에서 필요한데 host 에는 `app` 이 없다. 메인이 부팅 첫 구문에서 세팅하고
 * host fork 가 물려받는 WOOI_USER_DATA 를 읽는다 — logger.ts 와 같은 방식이다.
 */
export function wooiPluginDir(): string | null {
  const userData = process.env.WOOI_USER_DATA?.trim()
  return userData ? join(userData, 'claude-plugin') : null
}

/**
 * 세션 옵션에 실을 플러그인 경로. **실제로 생성돼 있을 때만** 돌려준다.
 *
 * 없는 경로를 넘기면 CLI 가 세션 자체를 열지 못한다. 생성이 실패했을 때 명령 몇 개를 잃는 것이
 * 워크스페이스를 통째로 잃는 것보다 낫다.
 */
export function resolveWooiPlugin(): string | null {
  const dir = wooiPluginDir()
  if (!dir) return null
  return existsSync(join(dir, '.claude-plugin', 'plugin.json')) ? dir : null
}

/** 생성한 플러그인 디렉토리 경로. 세션 옵션에 그대로 넘긴다. */
export function writeWooiPlugin(dir: string): string {
  const commandsDir = join(dir, 'commands')
  const manifestDir = join(dir, '.claude-plugin')
  mkdirSync(commandsDir, { recursive: true })
  mkdirSync(manifestDir, { recursive: true })

  writeFileSync(
    join(manifestDir, 'plugin.json'),
    JSON.stringify(
      {
        name: WOOI_COMMAND_NAMESPACE,
        description: 'Trigger Wooi’s built-in tools from the composer.',
        version: '1.0.0'
      },
      null,
      2
    ) + '\n',
    'utf8'
  )

  const owned = new Set(WOOI_COMMANDS.map((c) => `${c.name}.md`))
  for (const spec of WOOI_COMMANDS) {
    writeFileSync(join(commandsDir, `${spec.name}.md`), commandFile(spec), 'utf8')
  }

  // 카탈로그에서 빠진 명령의 파일이 남으면 자동완성에는 계속 뜨는데 아무 데도 이어지지 않는다.
  // 이름을 바꾸거나 지우는 일이 실제로 생기므로, 우리가 쓰지 않는 .md 는 지운다.
  for (const entry of readdirSync(commandsDir)) {
    if (entry.endsWith('.md') && !owned.has(entry)) {
      rmSync(join(commandsDir, entry), { force: true })
    }
  }

  log.info(
    `plugin: wrote ${WOOI_COMMANDS.length} /${WOOI_COMMAND_NAMESPACE}:* command(s) to ${dir}`
  )
  return dir
}

/**
 * 명령 1개의 마크다운. frontmatter 는 Claude Code 커맨드 규약 그대로다(description·argument-hint).
 *
 * `direct` 모드 명령의 파일도 만든다. 그 명령은 평소 입력창에서 가로채이므로 여기까지 오지
 * 않지만, 자동완성 목록을 한 곳에서 나오게 하고(모드가 섞여 있어도 사용자에게는 같은 명령이다)
 * 인터셉트가 빗나가도 에이전트가 같은 도구를 부르게 하는 폴백이 된다.
 */
function commandFile(spec: WooiCommandSpec): string {
  const front = [
    '---',
    `description: ${JSON.stringify(spec.description)}`,
    ...(spec.argumentHint ? [`argument-hint: ${JSON.stringify(spec.argumentHint)}`] : []),
    '---',
    ''
  ]
  return front.join('\n') + spec.prompt + '\n'
}
