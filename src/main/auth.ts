import { spawn } from 'node:child_process'
import * as pty from 'node-pty'
import { IPC } from '@shared/types'
import type { AgentAuthStatus, AuthStatus, GithubAuthStatus } from '@shared/types'
import { log } from './logger'
import { runLoginShell, isInstalled } from './shell'
import { setGithubConnected } from './github'
import { detectAntigravity } from './antigravity/executable'

/**
 * Claude / GitHub CLI 연동 상태를 조회하고 로그인·로그아웃을 트리거한다.
 *
 * 상태 조회는 사용자 로그인 셸(`$SHELL -lc`)로 실행한다 — `claude`(~/.local/bin)·
 * `gh`(homebrew) 가 GUI 로 띄운 앱의 빈약한 PATH 에는 없기 때문이다.
 * Claude 로그인(OAuth 코드 붙여넣기 플로우)은 별도 Terminal.app 을 띄우지 않고
 * 앱 내부 PTY 에서 실행한다 — `claude auth login` 이 브라우저를 열고 출력하는 인증 URL 과
 * "Paste code here" 프롬프트를 가로채, URL 은 모달에 노출하고 사용자가 붙여넣은 코드는
 * 다시 PTY 로 흘려보내 흐름을 앱 안에서 끝낸다. GitHub 로그인(`gh auth login --web`
 * 디바이스 플로우)도 같은 방식으로 앱 내부 PTY 에서 실행한다 — one-time 코드·디바이스 URL 을
 * 모달에 노출하고, gh 가 멈춰 기다리는 프롬프트는 기본값으로 대신 응답한다.
 * (gh 로그아웃은 계정 확인 프롬프트 때문에 여전히 Terminal 을 쓴다.)
 */

type Dispatch = (channel: string, payload: unknown) => void

/** ANSI 이스케이프(색·커서 제어)를 제거해 URL·프롬프트 텍스트를 안정적으로 매칭한다. */
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '')
}

function openInTerminal(command: string): void {
  const escaped = command.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  const script = `tell application "Terminal"\nactivate\ndo script "${escaped}"\nend tell`
  spawn('osascript', ['-e', script])
}

/**
 * 에이전트(Agent SDK)는 process.env 를 그대로 물려받으므로, 여기에 ANTHROPIC_API_KEY/
 * ANTHROPIC_AUTH_TOKEN 이 있으면 계정 로그인과 무관하게 그 키로 인증·과금한다. main 의
 * process.env 는 시작 시 로그인 셸에서 하이드레이트되므로(env.ts), 사용자의 셸 설정에 키가
 * export 돼 있으면 여기서 그대로 감지된다.
 */
function apiKeyInEnv(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim() || process.env.ANTHROPIC_AUTH_TOKEN?.trim())
}

async function getClaudeStatus(): Promise<AgentAuthStatus> {
  if (!(await isInstalled('claude'))) return { installed: false, loggedIn: false }

  const { stdout, code } = await runLoginShell('claude auth status --json')
  if (code !== 0) return { installed: true, loggedIn: false, apiKeyInEnv: apiKeyInEnv() }
  try {
    const json = JSON.parse(stdout.trim()) as Record<string, unknown>
    return {
      installed: true,
      loggedIn: Boolean(json.loggedIn),
      email: json.email as string | undefined,
      orgName: json.orgName as string | undefined,
      planType: json.subscriptionType as string | undefined,
      authMethod: json.authMethod as string | undefined,
      apiKeyInEnv: apiKeyInEnv()
    }
  } catch {
    return { installed: true, loggedIn: false, apiKeyInEnv: apiKeyInEnv() }
  }
}

async function getGithubStatus(): Promise<GithubAuthStatus> {
  if (!(await isInstalled('gh'))) {
    setGithubConnected(false)
    return { installed: false, loggedIn: false }
  }

  const { stdout, stderr, code } = await runLoginShell('gh auth status')
  if (code !== 0) {
    setGithubConnected(false)
    return { installed: true, loggedIn: false }
  }
  // gh 는 선택 연동이라 main 의 PR 조회·액션이 "미연결이면 조용히 건너뛰기" 판단에 이 값을 쓴다.
  // 상태 조회는 렌더러가 앱 시작·창 포커스·연동 패널에서 호출하므로 캐시가 자연히 최신으로 유지된다.
  setGithubConnected(true)
  const out = `${stdout}\n${stderr}`
  const account = out.match(/Logged in to \S+ account (\S+)/)?.[1]
  const protocol = out.match(/Git operations protocol:\s*(\S+)/)?.[1]
  return { installed: true, loggedIn: true, account, protocol }
}

/**
 * Codex 상태 조회기. main(index.ts)이 오케스트레이터를 만든 뒤 주입한다.
 *
 * 로그인 여부는 app-server 의 `account/read` 가 정본이다 — 자격증명이 OS 키체인에 있을 수 있어
 * 파일 존재로는 판단할 수 없다. 그 연결은 codex-host 가 소유하므로 여기서 직접 부르지 않고,
 * 백엔드가 넘겨준 함수를 통해 묻는다(auth.ts 가 에이전트 구현에 의존하지 않도록).
 */
let codexStatusProvider: (() => Promise<AgentAuthStatus>) | null = null

export function setCodexStatusProvider(provider: () => Promise<AgentAuthStatus>): void {
  codexStatusProvider = provider
}

async function getCodexStatus(): Promise<AgentAuthStatus> {
  // 미설치면 호스트를 띄울 필요조차 없다(설치 안내만 띄우면 된다).
  if (!(await isInstalled('codex'))) return { installed: false, loggedIn: false }
  if (!codexStatusProvider) return { installed: true, loggedIn: false }

  try {
    return await codexStatusProvider()
  } catch (err) {
    log.error('auth: codex status query failed', err)
    return {
      installed: true,
      loggedIn: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}

/** 매니저가 붙기 전에는 설치 상태만 보고한다. 브라우저 OAuth 확인은 후속 백엔드 구현이 맡는다. */
async function getAntigravityStatus(): Promise<AgentAuthStatus> {
  const install = await detectAntigravity()
  return { installed: install.path !== null, loggedIn: false }
}

export async function getAuthStatus(): Promise<AuthStatus> {
  const [claude, codex, antigravity, github] = await Promise.all([
    getClaudeStatus(),
    getCodexStatus(),
    getAntigravityStatus(),
    getGithubStatus()
  ])
  return { agents: { claude, codex, antigravity }, github }
}

/**
 * 진행 중인 Claude 로그인 PTY 세션. 동시에 하나만 둔다(새 시작 시 기존 것을 정리).
 * cancelled 는 사용자가 모달을 닫아 우리가 죽인 종료를 "실패"로 잘못 보고하지 않기 위한 가드.
 */
let claudeLoginSession: { proc: pty.IPty; cancelled: boolean } | null = null

/**
 * 앱 내부 PTY 에서 `claude auth login` 을 실행한다. 출력에서 인증 URL 과 "Paste code here"
 * 프롬프트를 감지해 renderer 에 알리고(awaiting-code), 프로세스 종료 시 성공 여부를 알린다(done).
 * 코드 제출은 claudeLoginSubmitCode(), 취소는 claudeLoginCancel() 로 이어진다.
 *
 * onSuccess 는 로그인이 성공으로 끝난 시점에 1회 호출된다 — 호출부는 여기서 세션 프로세스를
 * 재활용해(sessions.recycleAll) 옛 자격증명을 든 CLI 가 남지 않게 한다.
 */
export function claudeLoginStart(dispatch: Dispatch, onSuccess?: () => void): void {
  // 이미 떠 있는 세션이 있으면 조용히 정리하고 새로 시작한다(재시도/중복 클릭 대비).
  claudeLoginCancel()

  const shell = process.env.SHELL || '/bin/zsh'
  let proc: pty.IPty
  try {
    proc = pty.spawn(shell, ['-lc', 'claude auth login'], {
      name: 'xterm-256color',
      cols: 80,
      rows: 30,
      env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>
    })
  } catch (err) {
    log.error('auth: failed to spawn claude login pty', err)
    dispatch(IPC.evtClaudeLogin, { phase: 'done', success: false })
    return
  }

  const session = { proc, cancelled: false }
  claudeLoginSession = session

  // PTY 출력을 누적하며 "Paste code here" 프롬프트가 새로 나타날 때마다 코드 입력을 요청한다.
  // 잘못된 코드로 CLI 가 같은 프롬프트를 다시 띄우면 prompts 카운트가 늘어 재요청이 나간다.
  let out = ''
  let prompts = 0
  proc.onData((data) => {
    out += stripAnsi(data)
    const count = (out.match(/Paste code here/g) || []).length
    if (count > prompts) {
      prompts = count
      const url = out.match(/https?:\/\/\S+/)?.[0]
      dispatch(IPC.evtClaudeLogin, { phase: 'awaiting-code', url, reprompt: count > 1 })
    }
  })

  proc.onExit(({ exitCode }) => {
    if (claudeLoginSession === session) claudeLoginSession = null
    // 우리가 취소(kill)한 종료는 사용자 의도이므로 실패로 보고하지 않는다.
    if (session.cancelled) return
    const success = exitCode === 0
    // renderer 에 알리기 전에 세션을 재활용한다 — 계정이 바뀐 직후의 첫 메시지가 옛 자격증명을
    // 들고 있는 CLI 프로세스로 흘러가지 않게 한다(대화 맥락은 유지된다).
    if (success) {
      try {
        onSuccess?.()
      } catch (err) {
        log.error('auth: post-login session recycle failed', err)
      }
    }
    dispatch(IPC.evtClaudeLogin, { phase: 'done', success })
  })
}

/** 모달에서 붙여넣은 OAuth 코드를 진행 중인 로그인 PTY 로 제출한다(개행으로 줄 확정). */
export function claudeLoginSubmitCode(code: string): void {
  const trimmed = code.trim()
  if (!trimmed) return
  claudeLoginSession?.proc.write(`${trimmed}\r`)
}

/** 진행 중인 로그인 PTY 를 종료한다(모달 닫기/취소). 종료는 실패로 보고하지 않는다. */
export function claudeLoginCancel(): void {
  const session = claudeLoginSession
  if (!session) return
  session.cancelled = true
  claudeLoginSession = null
  try {
    session.proc.kill()
  } catch {
    // 이미 종료됨.
  }
}

export async function claudeLogout(): Promise<void> {
  // 로그아웃 완료를 기다린 뒤 resolve 해야, 렌더러가 이어서 호출하는 refreshAuth()가
  // 갱신된 상태를 읽어 UI 가 즉시 반영된다(spawn 후 바로 반환하면 폴링 전까지 미반영).
  const { code, stderr } = await runLoginShell('claude auth logout')
  if (code !== 0) log.error(`auth: claude logout exited with code ${code}`, stderr.trim())
}

/**
 * 진행 중인 GitHub 로그인 PTY 세션. Claude 와 마찬가지로 동시에 하나만 둔다.
 * cancelled 는 사용자가 모달을 닫아 우리가 죽인 종료를 "실패"로 잘못 보고하지 않기 위한 가드.
 */
let githubLoginSession: { proc: pty.IPty; cancelled: boolean } | null = null

/**
 * 앱 내부 PTY 에서 `gh auth login --web`(디바이스 플로우)을 실행한다 — 별도 Terminal 창 없이.
 * 출력에서 one-time 코드와 디바이스 URL 을 감지해 renderer 에 알리고(awaiting-auth),
 * gh 가 멈춰 기다리는 프롬프트("Press Enter to open…", "Authenticate Git…")는 기본값으로
 * 대신 응답해 흐름을 앱 안에서 끝낸다. 사용자는 모달에 표시된 코드를 브라우저에 입력하면 된다.
 * 프로토콜/호스트는 플래그로 고정해 대화형 질문을 건너뛴다.
 */
export function githubLoginStart(dispatch: Dispatch): void {
  // 이미 떠 있는 세션이 있으면 조용히 정리하고 새로 시작한다(재시도/중복 클릭 대비).
  githubLoginCancel()

  const shell = process.env.SHELL || '/bin/zsh'
  let proc: pty.IPty
  try {
    proc = pty.spawn(
      shell,
      ['-lc', 'gh auth login --hostname github.com --git-protocol https --web'],
      {
        name: 'xterm-256color',
        cols: 80,
        rows: 30,
        env: { ...process.env, TERM: 'xterm-256color' } as Record<string, string>
      }
    )
  } catch (err) {
    log.error('auth: failed to spawn gh login pty', err)
    dispatch(IPC.evtGithubLogin, { phase: 'done', success: false })
    return
  }

  const session = { proc, cancelled: false }
  githubLoginSession = session

  // PTY 출력을 누적하며 (1) one-time 코드를 최초 1회 모달에 노출하고,
  // (2) gh 가 멈춰 기다리는 프롬프트를 감지해 기본값(Enter)으로 대신 응답한다.
  let out = ''
  let announced = false
  let pressedEnter = false
  let confirmedGit = false
  proc.onData((data) => {
    out += stripAnsi(data)

    if (!announced) {
      const code = out.match(/one-time code:\s*([A-Z0-9]{4}-[A-Z0-9]{4})/)?.[1]
      if (code) {
        announced = true
        // gh 는 보통 "…open https://github.com/login/device in your browser…" 형태로 URL 을 찍는다.
        // 못 잡으면 표준 디바이스 URL 로 폴백한다(브라우저가 안 열렸을 때의 수동 링크).
        const url = out.match(/https?:\/\/\S*device\S*/)?.[0] ?? 'https://github.com/login/device'
        dispatch(IPC.evtGithubLogin, { phase: 'awaiting-auth', code, url })
      }
    }

    // "Press Enter to open … in your browser" — 브라우저를 열도록 Enter 를 대신 눌러 준다.
    if (!pressedEnter && /Press Enter to open/.test(out)) {
      pressedEnter = true
      session.proc.write('\r')
    }

    // https 프로토콜에서 뜨는 git 자격증명 설정 확인 — 기본값(Yes)으로 진행한다.
    if (!confirmedGit && /Authenticate Git with your GitHub credentials/.test(out)) {
      confirmedGit = true
      session.proc.write('\r')
    }
  })

  proc.onExit(({ exitCode }) => {
    if (githubLoginSession === session) githubLoginSession = null
    // 우리가 취소(kill)한 종료는 사용자 의도이므로 실패로 보고하지 않는다.
    if (session.cancelled) return
    dispatch(IPC.evtGithubLogin, { phase: 'done', success: exitCode === 0 })
  })
}

/** 진행 중인 GitHub 로그인 PTY 를 종료한다(모달 닫기/취소). 종료는 실패로 보고하지 않는다. */
export function githubLoginCancel(): void {
  const session = githubLoginSession
  if (!session) return
  session.cancelled = true
  githubLoginSession = null
  try {
    session.proc.kill()
  } catch {
    // 이미 종료됨.
  }
}

export function githubLogout(): void {
  // gh 로그아웃은 계정 확인 프롬프트가 뜰 수 있어 Terminal 에서 실행한다.
  openInTerminal('gh auth logout')
}
