import { describe, it, expect } from 'vitest'
import { IPC } from '@shared/types'
import { REMOTE_IPC, REMOTE_MAX_PROMPT_BYTES } from '@shared/remote'
import {
  REMOTE_COMMANDS,
  isMutatingRemoteCommand,
  validateRemoteCommand,
  type RemoteValidateContext
} from './allowlist'

/** 기본 컨텍스트 — 어떤 requestId 도 도구를 모른다(=updatedInput 불허). */
const ctx: RemoteValidateContext = { pendingPermissionTool: () => undefined }
const askCtx: RemoteValidateContext = { pendingPermissionTool: () => 'AskUserQuestion' }
const bashCtx: RemoteValidateContext = { pendingPermissionTool: () => 'Bash' }

const v = (channel: string, args: unknown[], c: RemoteValidateContext = ctx): unknown[] =>
  validateRemoteCommand(channel, args, c)

describe('원격 허용목록의 형태', () => {
  it('허용한 데스크톱 채널은 모두 실제 IPC 상수다', () => {
    const known = new Set<string>(Object.values(IPC))
    const remoteNative = new Set<string>(Object.values(REMOTE_IPC))
    for (const channel of REMOTE_COMMANDS.keys()) {
      if (remoteNative.has(channel)) continue
      expect(known, `${channel} 은 IPC 상수가 아니다`).toContain(channel)
    }
  })

  it('브리지 자체 명령은 IPC 네임스페이스를 오염시키지 않는다', () => {
    const known = new Set<string>(Object.values(IPC))
    for (const channel of Object.values(REMOTE_IPC)) {
      expect(known).not.toContain(channel)
      expect(channel.startsWith('remote:')).toBe(true)
    }
  })

  /**
   * 이 테스트가 이 파일의 존재 이유다.
   *
   * 원격 표면을 넓히는 것은 "핸들러 하나 추가" 만큼 쉬워서는 안 된다. 아래 목록의 채널이
   * 허용목록에 들어오면 빌드가 깨진다 — 정말 열어야 한다면 이 단언을 지우는 커밋이 리뷰에 남는다.
   */
  it('파괴적·셸 실행·자격증명 채널은 영구히 거부된다', () => {
    const forbidden = [
      // 네이티브 모달을 띄워 main 을 멈추거나, 리포 자체를 건드린다
      IPC.repoAdd,
      IPC.repoRemove,
      IPC.repoUpdate,
      IPC.repoAdoptCarry,
      IPC.repoReorder,
      IPC.repoListBranches,
      // worktree·브랜치를 만들고 지우고 force-push 한다
      IPC.workspaceCreate,
      IPC.workspaceArchive,
      IPC.workspaceUnarchive,
      IPC.workspaceRemove,
      IPC.workspaceRemoveArchived,
      IPC.workspaceRestack,
      IPC.workspaceSwitchBranch,
      IPC.stackSyncApply,
      IPC.stackSyncDismiss,
      // 로그인 셸을 spawn 한다
      IPC.workspaceOpenInEditor,
      IPC.workspaceOpenMemory,
      IPC.workspaceRevealInFinder,
      IPC.terminalStart,
      IPC.terminalInput,
      IPC.terminalRunCommand,
      IPC.terminalExec,
      IPC.terminalKill,
      IPC.terminalKillInline,
      IPC.terminalResize,
      IPC.scriptRun,
      IPC.scriptStop,
      // 파일 내용·git·PR 을 노출하거나 바꾼다
      IPC.fsList,
      IPC.fsRead,
      IPC.fsSearch,
      IPC.gitStatus,
      IPC.gitDiff,
      IPC.gitUpdateFromBase,
      IPC.gitAbortMerge,
      IPC.prCreate,
      IPC.prMerge,
      IPC.prClose,
      IPC.prReopen,
      IPC.prReady,
      // 자격증명·전역 설정·앱 수명주기
      IPC.authGetStatus,
      IPC.authClaudeLoginStart,
      IPC.authClaudeLoginSubmitCode,
      IPC.authClaudeLogout,
      IPC.authGithubLoginStart,
      IPC.authGithubLogout,
      IPC.settingsUpdate,
      IPC.openExternal,
      IPC.appSetBadge,
      IPC.updateCheck,
      IPC.updateQuitAndInstall,
      // 대화를 지우거나 별도 질의를 띄운다
      IPC.chatClear,
      IPC.chatSideQuestion,
      IPC.commandRun,
      IPC.mcpAction,
      IPC.commandRewindAction,
      // 원격 접근 자체를 관리한다. 이름이 `remote:` 로 시작하지만 **데스크톱 전용이다** —
      // 폰이 스스로 페어링을 시작하거나, 다른 기기를 revoke 하거나, 원격을 꺼 버릴 수 있으면 안 된다.
      IPC.remoteGetStatus,
      IPC.remoteSetEnabled,
      IPC.remotePairStart,
      IPC.remotePairConfirm,
      IPC.remotePairCancel,
      IPC.remoteRevokeDevice,
      IPC.remoteClearData,
      // 폰이 자기 미확인 표시를 스스로 지우거나 남의 것을 켤 수 있으면 안 된다.
      // 폰에서 읽었다는 사실은 remote:watch 한 경로로만 들어온다.
      IPC.remoteSetUnread,
      // ── upstream 이 나중에 추가한 채널들 ──────────────────────────────
      // 전부 미등록이라 이미 기본 거부지만, **이름을 여기 박아 두어야** 나중에 누군가
      // 허용목록을 넓힐 때 이 테스트가 깨지고 그 결정이 리뷰에 남는다.
      // 자격증명
      IPC.authCodexLoginStart,
      IPC.authCodexLoginCancel,
      IPC.authCodexLogout,
      IPC.authCodexRateLimits,
      // 창을 열고 닫는다(원격이 데스크톱 UI 를 조작해서는 안 된다)
      IPC.paneOpen,
      IPC.paneClose,
      IPC.paneFocus,
      IPC.paneSetWorkspace,
      IPC.paneOpenRepoSettings,
      IPC.paneSelectWorkspace,
      // 에이전트를 돌리고 GitHub 에 글을 쓴다
      IPC.reviewStart,
      IPC.reviewPost,
      IPC.reviewReply,
      IPC.reviewSubmit,
      IPC.reviewFollowUp,
      IPC.reviewCancel,
      IPC.reviewArchive,
      IPC.reviewUnarchive,
      IPC.reviewDismiss,
      IPC.reviewClose,
      // 파일시스템·브랜치·셸 출력
      IPC.workspaceAddDir,
      IPC.workspaceAddMemory,
      IPC.stackBaseKeep,
      IPC.stackBaseRetarget,
      IPC.scriptGetOutput,
      // 앱 재시작 예약
      IPC.updateSetRestartWhenIdle
    ]
    for (const channel of forbidden) {
      expect(REMOTE_COMMANDS.has(channel), `${channel} 이 원격에 열려 있다`).toBe(false)
    }
  })

  /**
   * PR 체크는 **읽기 전용으로만** 열려 있다. 같은 `pr:` 네임스페이스의 나머지(생성·머지·
   * 닫기·ready)는 위 forbidden 목록이 계속 막는다 — 폰에서 PR 을 머지할 수 있으면 잠금 해제된
   * 폰 하나로 main 에 코드를 넣을 수 있게 된다.
   */
  it('PR 체크는 workspaceId 하나만 받는 읽기 명령이다', () => {
    expect(v(IPC.prChecks, ['ws1'])).toEqual(['ws1'])
    expect(isMutatingRemoteCommand(IPC.prChecks)).toBe(false)
    expect(() => v(IPC.prChecks, [])).toThrow(/expected 1 args/)
    expect(() => v(IPC.prChecks, ['ws1', 'extra'])).toThrow(/expected 1 args/)
    expect(() => v(IPC.prChecks, [42])).toThrow(/workspaceId/)
  })

  it('미등록 채널은 기본 거부다', () => {
    expect(() => v('git:diff', ['ws1'])).toThrow(/not remotely invocable/)
    expect(() => v('totally:made-up', [])).toThrow(/not remotely invocable/)
  })

  it('mutating 플래그는 미등록 채널에 보수적으로 답한다', () => {
    expect(isMutatingRemoteCommand(IPC.chatSend)).toBe(true)
    expect(isMutatingRemoteCommand(IPC.appGetState)).toBe(false)
    expect(isMutatingRemoteCommand('git:diff')).toBe(true)
  })
})

describe('chat:send 검증', () => {
  it('정상 인자를 통과시키고 images 자리를 넘기지 않는다', () => {
    expect(v(IPC.chatSend, ['ws1', 'hello'])).toEqual(['ws1', 'hello'])
  })

  it('이미지 첨부를 거부한다', () => {
    expect(() =>
      v(IPC.chatSend, ['ws1', 'hi', [{ name: 'a.png', mediaType: 'image/png', dataBase64: 'x' }]])
    ).toThrow(/expected 2 args/)
  })

  it('빈 문자열과 공백만 있는 프롬프트를 거부한다', () => {
    expect(() => v(IPC.chatSend, ['ws1', ''])).toThrow(/must not be blank/)
    expect(() => v(IPC.chatSend, ['ws1', '   \n '])).toThrow(/must not be blank/)
  })

  it('상한을 넘는 프롬프트를 거부한다', () => {
    const tooBig = 'a'.repeat(REMOTE_MAX_PROMPT_BYTES + 1)
    expect(() => v(IPC.chatSend, ['ws1', tooBig])).toThrow(/limit is/)
  })

  it('바이트 길이로 재는다(멀티바이트 문자)', () => {
    // '가' 는 UTF-8 로 3바이트 — 문자 수로 재면 통과해 버린다.
    const chars = Math.floor(REMOTE_MAX_PROMPT_BYTES / 3) + 1
    expect(() => v(IPC.chatSend, ['ws1', '가'.repeat(chars)])).toThrow(/limit is/)
  })

  it('타입이 틀린 workspaceId 를 거부한다', () => {
    expect(() => v(IPC.chatSend, [42, 'hi'])).toThrow(/workspaceId/)
    expect(() => v(IPC.chatSend, ['', 'hi'])).toThrow(/workspaceId/)
  })
})

describe('permission:respond 검증', () => {
  it('단순 allow / deny 를 통과시킨다', () => {
    expect(v(IPC.permissionRespond, ['r1', { behavior: 'allow' }])).toEqual([
      'r1',
      { behavior: 'allow' }
    ])
    expect(v(IPC.permissionRespond, ['r1', { behavior: 'deny' }])).toEqual([
      'r1',
      { behavior: 'deny' }
    ])
  })

  it('rememberForSession 을 허용하되 boolean 만 받는다', () => {
    expect(
      v(IPC.permissionRespond, ['r1', { behavior: 'allow', rememberForSession: true }])
    ).toEqual(['r1', { behavior: 'allow', rememberForSession: true }])
    expect(() =>
      v(IPC.permissionRespond, ['r1', { behavior: 'allow', rememberForSession: 'yes' }])
    ).toThrow(/rememberForSession/)
  })

  it('AskUserQuestion 이 아니면 updatedInput 을 거부한다', () => {
    const decision = { behavior: 'allow', updatedInput: { command: 'rm -rf /' } }
    expect(() => v(IPC.permissionRespond, ['r1', decision], bashCtx)).toThrow(/AskUserQuestion/)
    expect(() => v(IPC.permissionRespond, ['r1', decision], ctx)).toThrow(/AskUserQuestion/)
  })

  it('AskUserQuestion 이면 updatedInput 을 허용한다', () => {
    const decision = { behavior: 'allow', updatedInput: { answers: { Q: 'A' } } }
    expect(v(IPC.permissionRespond, ['r1', decision], askCtx)).toEqual([
      'r1',
      { behavior: 'allow', updatedInput: { answers: { Q: 'A' } } }
    ])
  })

  it('알 수 없는 behavior 와 deny 에 붙은 잉여 필드를 거부한다', () => {
    expect(() => v(IPC.permissionRespond, ['r1', { behavior: 'maybe' }])).toThrow(/behavior/)
    expect(() => v(IPC.permissionRespond, ['r1', { behavior: 'deny', updatedInput: {} }])).toThrow(
      /deny decision/
    )
  })

  it('배열을 decision 으로 받지 않는다', () => {
    expect(() => v(IPC.permissionRespond, ['r1', []])).toThrow(/must be an object/)
    expect(() => v(IPC.permissionRespond, ['r1', null])).toThrow(/must be an object/)
  })
})

describe('workspace:setPermissionMode 검증 (에스컬레이션 금지)', () => {
  it('다운그레이드 방향만 허용한다', () => {
    expect(v(IPC.workspaceSetPermissionMode, ['ws1', 'default'])).toEqual(['ws1', 'default'])
    expect(v(IPC.workspaceSetPermissionMode, ['ws1', 'plan'])).toEqual(['ws1', 'plan'])
  })

  it('acceptEdits / auto 로의 상향을 거부한다', () => {
    expect(() => v(IPC.workspaceSetPermissionMode, ['ws1', 'acceptEdits'])).toThrow(
      /cannot be set remotely/
    )
    expect(() => v(IPC.workspaceSetPermissionMode, ['ws1', 'auto'])).toThrow(
      /cannot be set remotely/
    )
  })
})

describe('remote:transcript 검증', () => {
  it('쿼리를 생략하면 최대 페이지를 요청한다', () => {
    expect(v(REMOTE_IPC.transcript, ['ws1'])).toEqual(['ws1', { limit: 200 }])
  })

  it('limit 을 상한으로 자른다', () => {
    expect(v(REMOTE_IPC.transcript, ['ws1', { limit: 5000 }])).toEqual(['ws1', { limit: 200 }])
  })

  it('beforeTs 를 통과시킨다', () => {
    expect(v(REMOTE_IPC.transcript, ['ws1', { beforeTs: 1000, limit: 10 }])).toEqual([
      'ws1',
      { limit: 10, beforeTs: 1000 }
    ])
  })

  it('잘못된 limit·beforeTs 를 거부한다', () => {
    expect(() => v(REMOTE_IPC.transcript, ['ws1', { limit: 0 }])).toThrow(/positive integer/)
    expect(() => v(REMOTE_IPC.transcript, ['ws1', { limit: 1.5 }])).toThrow(/positive integer/)
    expect(() => v(REMOTE_IPC.transcript, ['ws1', { beforeTs: NaN }])).toThrow(/finite number/)
  })
})

describe('remote:watch / remote:ping 검증', () => {
  it('null 은 구독 해제를 뜻한다', () => {
    expect(v(REMOTE_IPC.watch, [null])).toEqual([null])
    expect(v(REMOTE_IPC.watch, ['ws1'])).toEqual(['ws1'])
  })

  it('ping 은 인자를 받지 않는다', () => {
    expect(v(REMOTE_IPC.ping, [])).toEqual([])
    expect(() => v(REMOTE_IPC.ping, ['x'])).toThrow(/expected 0 args/)
  })
})

describe('remote:unpairSelf 검증', () => {
  it('인자 없는 자기 해제만 허용한다', () => {
    expect(REMOTE_COMMANDS.has(REMOTE_IPC.unpairSelf)).toBe(true)
    expect(v(REMOTE_IPC.unpairSelf, [])).toEqual([])
    expect(() => v(REMOTE_IPC.unpairSelf, ['other-device'])).toThrow(/expected 0 args/)
  })
})
