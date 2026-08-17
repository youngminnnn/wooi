import type { RemoteState, RemoteWorkspace } from '@shared/remote'
import type { ChatItem, PermissionRequest } from '@shared/types'

export const DEMO_PERMISSION_ID = 'demo-permission'

interface DemoSession {
  state: RemoteState
  transcripts: Map<string, ChatItem[]>
}

function workspace(
  values: Partial<RemoteWorkspace> & Pick<RemoteWorkspace, 'id' | 'repoId' | 'name' | 'branch'>,
  lastActiveAt: number
): RemoteWorkspace {
  return {
    displayName: null,
    status: 'idle',
    permissionMode: 'default',
    model: null,
    effort: null,
    archived: false,
    muted: false,
    prNumber: null,
    attention: null,
    agentBackend: 'claude',
    multiAgent: false,
    parentWorkspaceId: null,
    rateLimit: null,
    permissionModeFooter: null,
    statusLine: null,
    pr: null,
    actsWithoutAsking: false,
    lastActiveAt,
    ...values
  }
}

export function createDemoSession(now: number = Date.now()): DemoSession {
  const permission: PermissionRequest = {
    requestId: DEMO_PERMISSION_ID,
    workspaceId: 'mobile-checkout',
    toolName: 'Bash',
    title: 'Run the mobile test suite?',
    displayName: 'Run tests',
    kind: 'command',
    input: { command: ['npm', 'test', '--', '--runInBand'] },
    rule: 'Bash(npm test:*)'
  }
  const workspaces = [
    workspace(
      {
        id: 'mobile-checkout',
        repoId: 'wooi',
        name: 'mobile-checkout',
        displayName: 'Mobile checkout flow',
        branch: 'feat/mobile-checkout',
        status: 'running',
        model: 'Claude Opus 4.1',
        effort: 'high',
        // 라벨·사용량은 랩탑이 만들어 보내는 것과 같은 모양이다(main/remote/mirror 의 projectStatusLine).
        statusLine: {
          model: 'Opus 5 (1M context)',
          effort: 'High',
          context: { usedTokens: 128_400, maxTokens: 1_000_000, percentage: 0.13 },
          compacting: false
        },
        attention: 'permission',
        multiAgent: true,
        // 문구는 랩탑이 백엔드 서술자에서 뽑아 보내는 것과 같은 값이다(src/main/agent/backend.ts).
        permissionModeFooter: { symbol: '⏵⏵', text: 'accept edits on', tone: 'caution' },
        prNumber: 184,
        pr: { number: 184, state: 'ready', label: 'Ready for review' }
      },
      now - 25_000
    ),
    workspace(
      {
        id: 'remote-banner',
        repoId: 'wooi',
        name: 'remote-banner',
        displayName: 'Remote status banner',
        branch: 'feat/remote-banner',
        agentBackend: 'codex',
        model: 'gpt-5.4',
        effort: 'xhigh',
        statusLine: {
          model: 'GPT-5.4',
          effort: 'Extra high',
          context: { usedTokens: 291_000, maxTokens: 400_000, percentage: 0.73 },
          compacting: false
        },
        parentWorkspaceId: 'mobile-checkout',
        muted: true,
        prNumber: 185,
        pr: { number: 185, state: 'draft', label: 'Draft' }
      },
      now - 4 * 60_000
    ),
    workspace(
      {
        id: 'relay-reconnect',
        repoId: 'wooi',
        name: 'relay-reconnect',
        displayName: 'Relay reconnect handling',
        branch: 'fix/relay-reconnect',
        status: 'error',
        attention: 'error',
        // 미확인 점·배지를 데모에서도 보여 준다 — 에러로 끝난 턴도 랩탑에서는 미확인이다.
        unread: true,
        agentBackend: 'codex',
        model: 'gpt-5.4',
        effort: 'high',
        statusLine: {
          model: 'GPT-5.4',
          effort: 'High',
          context: { usedTokens: 372_000, maxTokens: 400_000, percentage: 0.93 },
          compacting: false
        }
      },
      now - 12 * 60_000
    ),
    workspace(
      {
        id: 'usage-recovery',
        repoId: 'wooi',
        name: 'usage-recovery',
        displayName: 'Usage limit recovery',
        branch: 'test/usage-recovery',
        rateLimit: { kind: 'resuming', at: now + 18 * 60_000 },
        model: 'Claude Sonnet 4',
        // 첫 턴 전이라 사용량은 아직 없다 — 게이지는 자리만 잡고 '—' 로 나온다.
        statusLine: {
          model: 'Sonnet 5 (1M context)',
          effort: 'Model default',
          context: null,
          compacting: false
        }
      },
      now - 20 * 60_000
    ),
    workspace(
      {
        id: 'docs-refresh',
        repoId: 'docs',
        name: 'docs-refresh',
        displayName: 'Remote setup guide',
        branch: 'docs/remote-setup',
        status: 'running',
        model: 'Claude Sonnet 4',
        permissionMode: 'acceptEdits',
        permissionModeFooter: { symbol: '⏵⏵', text: 'accept edits on', tone: 'caution' },
        statusLine: {
          model: 'Sonnet 5 (1M context)',
          effort: 'Model default',
          context: { usedTokens: 640_000, maxTokens: 1_000_000, percentage: 0.64 },
          compacting: true
        }
      },
      now - 2 * 60_000
    ),
    workspace(
      {
        id: 'release-notes',
        repoId: 'docs',
        name: 'release-notes',
        displayName: 'Release notes',
        branch: 'docs/release-notes',
        // 조용히 끝난 턴의 미확인 — 왼쪽 상태 아이콘은 idle 인데 오른쪽 점만 켜지는 경우다.
        unread: true,
        agentBackend: 'codex',
        model: 'gpt-5.4-mini',
        prNumber: 42,
        pr: { number: 42, state: 'merged', label: 'Merged' },
        permissionModeFooter: { symbol: '⏸', text: 'plan mode on', tone: 'readOnly' },
        statusLine: {
          model: 'GPT-5.4 mini',
          effort: 'Medium',
          context: { usedTokens: 84_000, maxTokens: 400_000, percentage: 0.21 },
          compacting: false
        }
      },
      now - 45 * 60_000
    )
  ]

  const richTranscript: ChatItem[] = [
    {
      id: 'demo-user',
      type: 'user',
      text: 'Add a clear offline banner and verify the mobile checkout flow.',
      ts: now - 75_000
    },
    {
      id: 'demo-thinking',
      type: 'thinking',
      text: 'I need to trace the connection state, then exercise both the list and detail screens.',
      ts: now - 68_000
    },
    // 스킬 호출도 평범한 도구 한 줄이다(Claude Code CLI 와 같다). 데모에 하나 끼워 두면
    // 페어링 없이도 시뮬레이터에서 그 줄이 어떻게 그려지는지 눈으로 볼 수 있다.
    {
      id: 'demo-skill-use',
      type: 'tool_use',
      toolId: 'tool-demo-skill',
      name: 'Skill',
      input: { skill: 'wooi-run' },
      ts: now - 64_000
    },
    {
      id: 'demo-skill-result',
      type: 'tool_result',
      toolId: 'tool-demo-skill',
      text: 'Launching skill: wooi-run',
      isError: false,
      ts: now - 62_000
    },
    {
      id: 'demo-tool-use',
      type: 'tool_use',
      toolId: 'tool-demo-1',
      name: 'Read',
      input: { file_path: 'apps/mobile/app/index.tsx' },
      ts: now - 60_000
    },
    {
      id: 'demo-tool-result',
      type: 'tool_result',
      toolId: 'tool-demo-1',
      text: 'Found the connection status header and workspace sections.',
      isError: false,
      ts: now - 52_000
    },
    {
      id: 'demo-bash',
      type: 'bash',
      agent: true,
      command: 'npx tsc --noEmit',
      output: 'Type checking completed successfully.',
      exitCode: 0,
      running: false,
      ts: now - 44_000
    },
    {
      id: 'demo-assistant',
      type: 'assistant',
      text: 'The banner is in place. I am waiting for permission to run the final test suite.',
      ts: now - 35_000
    },
    {
      id: 'demo-result',
      type: 'result',
      subtype: 'success',
      isError: false,
      durationMs: 41_200,
      numTurns: 3,
      costUsd: 0.08,
      ts: now - 30_000
    }
  ]

  /**
   * 워크스페이스마다 그럴듯한 대화를 채운다.
   *
   * 한 줄짜리로 두면 심사자가 열어 본 워크스페이스가 하필 그것일 때 빈 화면을 본다 — 실제로
   * 그랬다. 어느 것을 열어도 앱이 무엇을 보여 주는 도구인지 읽혀야 한다.
   */
  const sampleExchange = (item: RemoteWorkspace, ask: string, reply: string): ChatItem[] => [
    { id: `${item.id}-user`, type: 'user', text: ask, ts: item.lastActiveAt - 90_000 },
    {
      id: `${item.id}-thinking`,
      type: 'thinking',
      text: 'Reading the files that this change touches, then planning the edits.',
      ts: item.lastActiveAt - 75_000
    },
    {
      id: `${item.id}-tool`,
      type: 'tool_use',
      toolId: `${item.id}-tool-1`,
      name: 'Read',
      input: { file_path: `${item.branch}/README.md` },
      ts: item.lastActiveAt - 60_000
    },
    { id: `${item.id}-assistant`, type: 'assistant', text: reply, ts: item.lastActiveAt - 30_000 }
  ]

  const SAMPLES: Record<string, [string, string]> = {
    'relay-reconnect': [
      'The phone stops receiving updates after the computer sleeps. Can you look?',
      'The socket dies during sleep and nothing re-opens it. I added a resume hook that reconnects immediately instead of waiting for the next heartbeat.'
    ],
    'remote-banner': [
      'Split the offline banner so it says whether the phone or the computer is the one that is away.',
      'Done. The phone now polls the computer’s last-seen time separately, so "you are offline" and "your computer is asleep" are different messages.'
    ],
    'usage-recovery': [
      'What happens to a queued turn when the usage limit resets?',
      'It resumes on its own. The workspace keeps the queued turn and starts it as soon as the limit clears — the countdown in the sidebar is the scheduled time.'
    ],
    'docs-refresh': [
      'Write the setup section for pairing a phone.',
      'Drafted it: install, scan the code shown on the computer, then confirm the six digits match on both screens. I kept the warning about rejecting a mismatch.'
    ],
    'release-notes': [
      'Summarise what changed for the release notes.',
      'Pulled the merged PRs since the last tag and grouped them: remote access, two crash fixes, and the new usage-limit countdown.'
    ]
  }

  const transcripts = new Map<string, ChatItem[]>()
  for (const item of workspaces) {
    const sample = SAMPLES[item.id]
    transcripts.set(
      item.id,
      item.id === 'mobile-checkout'
        ? richTranscript
        : sample
          ? sampleExchange(item, sample[0], sample[1])
          : [
              {
                id: `${item.id}-assistant`,
                type: 'assistant',
                text: `This is a sample session for ${item.displayName ?? item.name}.`,
                ts: item.lastActiveAt
              }
            ]
    )
  }

  return {
    state: {
      rev: 1,
      machine: { id: 'demo-mac', name: 'Demo MacBook Pro', appVersion: '1.12.0' },
      repos: [
        { id: 'wooi', name: 'wooi' },
        { id: 'docs', name: 'product-docs' }
      ],
      workspaces,
      // 데모에도 요금제 사용량을 둔다 — 페어링 전에 앱을 훑어보는 사람에게 설정 화면이
      // 절반만 채워진 채로 보이지 않게 하기 위해서다.
      planUsage: [
        {
          agent: 'claude',
          agentLabel: 'Claude Code',
          plan: 'max',
          fetchedAt: now - 3 * 60_000,
          windows: [
            { label: '5-hour', usedPct: 42, resetsAt: now + 2 * 3_600_000 + 10 * 60_000 },
            { label: '7-day', usedPct: 78, resetsAt: now + 3 * 86_400_000 },
            { label: 'Opus', usedPct: 12, resetsAt: now + 3 * 86_400_000 }
          ]
        },
        // 계정이 둘일 때 화면이 어떻게 갈리는지가 데모에서도 보여야 한다 — 창 이름만으로는
        // ('5-hour' vs 'Weekly') 어느 계정의 한도인지 알 수 없기 때문이다.
        {
          agent: 'codex',
          agentLabel: 'Codex',
          plan: null,
          fetchedAt: now - 82 * 60_000,
          windows: [{ label: 'Weekly', usedPct: 93, resetsAt: now + 2 * 86_400_000 }]
        }
      ],
      pendingPermissions: [permission]
    },
    transcripts
  }
}
