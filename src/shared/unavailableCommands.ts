/**
 * Wooi 에서 쓸 수 없는 Claude Code 명령을 두 경계에서 다루는 단일 소스다.
 * `HIDDEN_SDK_COMMANDS` 는 자동완성 오염을 막고, `UNAVAILABLE_COMMANDS` 는 사용자가 터미널 습관대로
 * 직접 입력한 명령이 CLI 로 넘어가기 전에 가로챈다. 두 목록은 숨길 필요와 안내할 필요가 서로
 * 다르므로 분리한다. SDK 응답에는 `isHidden` 이 없고 이름·설명·인자 힌트·별칭만 오므로 이름
 * 블록리스트 외에는 CLI 내부 명령을 안정적으로 거를 방법이 없다.
 */

export const HIDDEN_SDK_COMMANDS: readonly string[] = [
  // 서버 런치 세션 전용 내부 명령 — CLI 에 `isHidden:!0`, `disableModelInvocation:!0` 로 등록돼 있다.
  '__remote-workflow',
  // 같은 계열 — workflow_launch 이벤트 세션 전용이다.
  'workflow-launch-exec',
  // JS 힙을 `~/Desktop` 에 덤프하는 디버그용 명령이다(`isHidden:!0`).
  'heapdump',
  // `/design` 의 숨은 하위 명령이다(`isHidden:!0`).
  'design-consent',
  // `/design` 의 숨은 하위 명령으로 위 명령과 같은 이유로 감춘다.
  'design-revoke',
  // deprecated — CLI 설명 자체가 "Renamed to /usage-credits" 다.
  'extra-usage',
  // 터미널 프롬프트 바 색상이다. Wooi 에는 프롬프트 바가 없고, 실측하면
  // "Session color set to: cyan" 이라는 성공 메시지만 오고 아무 일도 일어나지 않는다.
  'color'
]

// `auto-mode-setup` 은 CLI 에 `type:"local"` · `supportsNonInteractive:!0` ·
// `get isHidden(){return !xn()}` 로 등록돼 비대화형(=Wooi)에서 오히려 노출되도록 만든 변종이다.
// `run-skill-generator` 는 `userInvocable:!0` 에 템플릿 파일을 내놓는 스킬 계열이라 TUI 의존이 없다.
// 따라서 두 명령은 일부러 자동완성에 남긴다.

export function isHiddenSdkCommand(name: string): boolean {
  return HIDDEN_SDK_COMMANDS.includes(name)
}

export interface UnavailableCommand {
  /** 이 안내로 처리할 명령 이름들(별칭 포함). */
  names: readonly string[]
  /** 사용자에게 보여 줄 한 줄 안내(영문). */
  message: string
}

/** 다른 워크스페이스가 구현 중이라 절대 가로막으면 안 되는 명령들(테스트가 지킨다). */
export const RESERVED_COMMANDS: readonly string[] = [
  'status',
  'skills',
  'hooks',
  'plan',
  'login',
  'logout',
  'rename',
  'tasks',
  'bashes',
  'export',
  'bug',
  'feedback',
  'release-notes',
  'privacy-settings',
  'memory',
  'copy',
  'fork',
  'branch',
  'rewind',
  'stop',
  'subtask'
]

/*
 * 아래 명령은 다른 워크스페이스가 지금 구현 중이므로 이 목록에 절대 추가하지 않는다:
 * /status /skills /hooks /plan /login /logout /rename /tasks /bashes /export /bug /feedback
 * /release-notes /privacy-settings /memory /copy /fork /branch /rewind /stop /subtask
 */

/*
 * 일부러 넣지 않은 것들:
 * - `rate-limit-options` · `pro-trial-expired` — CLI 가 특정 상황에 스스로 띄우는 내부 화면이라
 *   사용자가 칠 일이 없다.
 */

// 두 목록은 직교한다. `HIDDEN_SDK_COMMANDS` 는 자동완성에서 빼고, `UNAVAILABLE_COMMANDS` 는 타이핑해
// 보낸 것을 가로챈다. 한 이름이 둘 다 필요할 수 있다. `known` 은 이미 걸러진 목록에서 나오므로 감춘
// 이름은 절대 `known` 에 들어가지 않고, 따라서 게이트가 확실히 잡는다.
//
// 판정 방법: 등록 모양은 노출 여부를 예측하지 못한다. 같은 `type:"local"` ·
// `supportsNonInteractive:!0` 인데 `auto-mode-setup` 은 목록에 있고 `skill-doctor` · `exit` · `rewind` 는
// 없다. 변수에 대입만 되고 레지스트리 배열에는 안 실리는 죽은 정의가 있는 것으로 보인다. 따라서
// (1) `supportedCommands()` 에 이름이 있는지 확인하고, (2) 실제로 한 번 보내 응답을 본다. 바이너리
// grep 은 "왜 그런가" 를 설명할 때만 쓴다.
//
// 근거에는 확인한 CLI 버전을 함께 적는다. Claude Code 는 자동 업데이트되고 심볼 이름도 바뀐다.
// 비대화형 여부를 뜻하는 헬퍼는 CLI 2.1.233 에서 `xn()`, 2.1.240 에서 `Un()` 이었다. 이 파일의
// 바이너리 인용은 별도 표기가 없으면 CLI 2.1.233(SDK 0.3.233)에서 읽은 것이다.
export const UNAVAILABLE_COMMANDS: readonly UnavailableCommand[] = [
  // Wooi 설정이 대신 맡는 터미널 외형 명령이다.
  {
    names: ['theme'],
    message: "Wooi isn't a terminal UI — choose the appearance you want in Wooi's settings."
  },
  // 감춰도 타이핑하면 CLI 로 새어 나가고, 실측하면 "Session color set to: cyan" 이라는 거짓 성공이
  // 온다. 아무 일도 안 일어나는데 됐다고 말하므로 실패 메시지보다 나쁘다.
  // `HIDDEN_SDK_COMMANDS` 에도 함께 있는 유일한 이름이다.
  {
    names: ['color'],
    message: "Wooi has no terminal prompt bar to colour — change the appearance in Wooi's settings."
  },
  // 전부 CLI 에 `type:"local-jsx"` 로만 등록돼 있어 비대화형에서는 죽는다. `vim` 은 2.1.233 에서
  // 아예 제거돼 "Unknown command: /vim" 이 온다.
  {
    names: ['tui', 'terminal-setup', 'scroll-speed', 'focus', 'brief', 'vim'],
    message: "This tunes the Claude Code terminal UI, which Wooi doesn't use."
  },
  // 터미널 세션을 다시 고르는 명령이며, Wooi 에서는 사이드바의 워크스페이스가 그 역할을 맡는다.
  {
    names: ['resume'],
    message:
      'Every Wooi workspace keeps its own conversation — reopen a workspace from the sidebar to pick it back up.'
  },
  // Claude 요금제와 사용량을 관리하는 계정 명령이다.
  {
    names: ['upgrade', 'passes'],
    message: 'Plans and usage are managed in your Claude account at claude.ai.'
  },
  // Wooi 워크스페이스는 git worktree 에 고정되므로 작업 디렉터리를 바꿀 수 없다.
  {
    names: ['cd'],
    message:
      "Each workspace is pinned to its own git worktree, so the working directory can't be changed."
  },
  // Claude Code 설치를 직접 바꾸는 명령이다. `/update` 는 `type:"local"` 변종도 있지만
  // `supportsNonInteractive:!1` · `isEnabled:()=>!1` 라 실제로 도는 것은 local-jsx 쪽뿐이다.
  // `/version` 도 `type:"local"` 변종이 `isEnabled:()=>!1` 라 죽어 있고 실측하면
  // "Unknown command: /version" 이 온다. 설치를 Wooi 가 관리한다는 같은 답이 맞다.
  {
    names: ['install', 'update', 'version'],
    message: 'Wooi manages the Claude Code install for you.'
  },
  // 플러그인의 설치·제거는 터미널 CLI 에 남기고 Wooi 에서는 리로드만 지원한다.
  {
    names: ['plugin'],
    message:
      'Wooi can reload plugins with /reload-plugins, but installing and removing them is done in the Claude Code CLI.'
  },
  // Claude Code 원격 세션 명령이다. `rc` 는 `remote-control` 의 별칭이다. 안내에서 Wooi 자체의
  // 모바일 페어링 기능을 가리키지 않는다 — 연결하지 않기로 결정된 사안이다.
  {
    names: ['remote-control', 'rc', 'session', 'remote-env'],
    message: "Claude Code's remote sessions aren't available in Wooi."
  },
  // 작업을 Anthropic 클라우드로 넘기는 계열이다. `tp` 는 `teleport` 의 별칭이다.
  {
    names: ['teleport', 'tp', 'ultraplan', 'autofix-pr'],
    message:
      "Wooi runs every workspace in a local git worktree, so there's nowhere for cloud-run work to land."
  },
  // CLI 의 전제 자체가 Wooi 에서 성립하지 않는다. `bg` 는 별칭이다.
  {
    names: ['background', 'bg'],
    message: "Every Wooi workspace already runs in the background — there's nothing to move."
  },
  // CLI 2.1.240 실측 — `supportedCommands()` 에 없고, 보내면
  // `"/exit isn't available in this environment."` 가 온다. `quit` 은 별칭이다.
  {
    names: ['exit', 'quit'],
    message:
      "Wooi has no session to quit — close the window, or archive the workspace when you're done."
  },
  // Claude Code 터미널 앱 안에서만 제공되는 제품·설정 진입 명령이다. CLI 내부의 백그라운드
  // 서비스·루프·워크플로 뷰, IDE 연동 패널, 인증 재설정 마법사도 전부 `type:"local-jsx"` 로만
  // 등록돼 있다. `skill-doctor` 는 CLI 2.1.240 실측에서 `supportedCommands()` 에 없고
  // `"Unknown command: /skill-doctor"` 가 온다 — 오타를 쳤다는 말처럼 읽혀서 미지원 응답 중 가장
  // 나쁘다.
  {
    names: [
      'advisor',
      'artifacts',
      'powerup',
      'wellbeing',
      'mobile',
      'desktop',
      'install-github-app',
      'web-setup',
      'daemon',
      'loops',
      'workflows',
      'ide',
      'setup-bedrock',
      'setup-vertex',
      'skill-doctor'
    ],
    message: 'This only runs in the Claude Code terminal app.'
  }
]

/**
 * "/theme" 처럼 Wooi 에서 쓸 수 없는 명령이면 그 안내를 돌려준다(아니면 null).
 * @param known 사용자가 같은 이름의 개인 명령·스킬을 정의했다면 실제로 동작하므로 가로채면 안 된다.
 * 목록에 이름이 있다는 것은 이 워크스페이스가 그 명령에 답할 수 있다는 뜻이며, 미래 CLI 가 이 중
 * 하나를 보고하기 시작해도 게이트가 저절로 느슨해진다.
 */
export function matchUnavailableCommand(
  text: string,
  known?: readonly string[]
): UnavailableCommand | null {
  const match = /^\/([\w-]+)(?:\s[\s\S]*)?$/.exec(text)
  if (!match) return null
  const name = match[1]
  if (known?.includes(name)) return null
  return UNAVAILABLE_COMMANDS.find((command) => command.names.includes(name)) ?? null
}
