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
        attention: 'permission',
        multiAgent: true,
        permissionModeFooter: {
          symbol: '⏸',
          text: 'Asks before running commands',
          tone: 'readOnly'
        },
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
        agentBackend: 'codex',
        model: 'gpt-5.4',
        effort: 'high'
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
        model: 'Claude Sonnet 4'
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
        permissionModeFooter: {
          symbol: '⚡',
          text: 'Accepts file edits automatically',
          tone: 'caution'
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
        agentBackend: 'codex',
        model: 'gpt-5.4-mini',
        prNumber: 42,
        pr: { number: 42, state: 'merged', label: 'Merged' }
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

  const transcripts = new Map<string, ChatItem[]>()
  for (const item of workspaces) {
    transcripts.set(
      item.id,
      item.id === 'mobile-checkout'
        ? richTranscript
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
      pendingPermissions: [permission]
    },
    transcripts
  }
}
