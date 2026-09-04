import { describe, it, expect } from 'vitest'
import { parseConductor, parseOrca } from './parse'

describe('parseConductor', () => {
  const repoRow = {
    id: 'r1',
    name: 'playground',
    root_path: '/Users/me/Projects/playground',
    setup_script: 'npm install',
    run_script: 'npm run dev',
    archive_script: 'docker compose down',
    hidden: 0
  }

  it('리포와 그 리포의 워크스페이스를 함께 읽는다', () => {
    const repos = parseConductor(
      [repoRow],
      [
        {
          id: 'w1',
          repository_id: 'r1',
          directory_name: 'tacoma',
          workspace_path: '/Users/me/conductor/workspaces/playground/tacoma',
          state: 'ready'
        }
      ],
      '/Users/me'
    )
    expect(repos).toHaveLength(1)
    expect(repos[0]).toMatchObject({
      externalId: 'r1',
      name: 'playground',
      path: '/Users/me/Projects/playground',
      setupScript: 'npm install',
      archiveScript: 'docker compose down',
      runScripts: [{ name: 'dev', command: 'npm run dev' }]
    })
    expect(repos[0].workspaces).toEqual([
      { path: '/Users/me/conductor/workspaces/playground/tacoma', name: 'tacoma' }
    ])
  })

  it('workspace_path 가 없던 옛 레코드는 관례 경로로 채운다', () => {
    const repos = parseConductor(
      [repoRow],
      [{ id: 'w1', repository_id: 'r1', directory_name: 'porto' }],
      '/Users/me'
    )
    expect(repos[0].workspaces).toEqual([
      { path: '/Users/me/conductor/workspaces/playground/porto', name: 'porto' }
    ])
  })

  it('다른 리포의 워크스페이스를 섞지 않는다', () => {
    const repos = parseConductor(
      [repoRow, { id: 'r2', name: 'other', root_path: '/Users/me/Projects/other' }],
      [
        { id: 'w1', repository_id: 'r1', workspace_path: '/a/one' },
        { id: 'w2', repository_id: 'r2', workspace_path: '/b/two' }
      ],
      '/Users/me'
    )
    expect(repos[0].workspaces.map((ws) => ws.path)).toEqual(['/a/one'])
    expect(repos[1].workspaces.map((ws) => ws.path)).toEqual(['/b/two'])
  })

  it('아카이브된 워크스페이스와 숨긴 리포는 뺀다', () => {
    const repos = parseConductor(
      [repoRow, { id: 'r2', name: 'hidden', root_path: '/x', hidden: 1 }],
      [
        { id: 'w1', repository_id: 'r1', workspace_path: '/a/one', state: 'archived' },
        { id: 'w2', repository_id: 'r1', workspace_path: '/a/two', state: 'ready' }
      ],
      '/Users/me'
    )
    expect(repos.map((repo) => repo.externalId)).toEqual(['r1'])
    expect(repos[0].workspaces.map((ws) => ws.path)).toEqual(['/a/two'])
  })

  it('root_path 가 없는 레코드와 이상한 입력을 조용히 버린다', () => {
    expect(parseConductor([{ id: 'r1' }], [], '/Users/me')).toEqual([])
    expect(parseConductor(null, undefined, '/Users/me')).toEqual([])
    expect(parseConductor(['nonsense', 42], [], '/Users/me')).toEqual([])
  })

  it('실행 명령이 없으면 run script 도 만들지 않는다', () => {
    const repos = parseConductor([{ ...repoRow, run_script: '' }], [], '/Users/me')
    expect(repos[0].runScripts).toEqual([])
  })
})

describe('parseOrca', () => {
  const data = {
    repos: [
      { id: 'r1', path: '/Users/me/Projects/api', displayName: 'API' },
      { id: 'r2', path: '/Users/me/Projects/web' }
    ],
    worktreeMeta: {
      'r1::/Users/me/Projects/api': { displayName: 'main checkout' },
      'r1::/Users/me/orca/api/feature-a': { displayName: 'Feature A' },
      'r1::/Users/me/orca/api/old': { displayName: 'Old', isArchived: true },
      'r2::/Users/me/orca/web/feature-b': {}
    }
  }

  it('리포와 worktree 메타를 짝지어 읽는다', () => {
    const repos = parseOrca(data)
    expect(repos.map((repo) => repo.name)).toEqual(['API', 'web'])
    expect(repos[0].workspaces).toEqual([
      { path: '/Users/me/orca/api/feature-a', name: 'Feature A' }
    ])
    // 표시 이름이 없으면 디렉터리 이름을 쓴다.
    expect(repos[1].workspaces).toEqual([
      { path: '/Users/me/orca/web/feature-b', name: 'feature-b' }
    ])
  })

  it('메인 체크아웃과 아카이브된 worktree 는 후보가 아니다', () => {
    const paths = parseOrca(data).flatMap((repo) => repo.workspaces.map((ws) => ws.path))
    expect(paths).not.toContain('/Users/me/Projects/api')
    expect(paths).not.toContain('/Users/me/orca/api/old')
  })

  it('원격·폴더 리포는 건너뛴다', () => {
    const repos = parseOrca({
      repos: [
        { id: 'r1', path: '/a', connectionId: 'ssh:box' },
        { id: 'r2', path: '/b', executionHostId: 'runtime:vm' },
        { id: 'r3', path: '/c', kind: 'folder' },
        { id: 'r4', path: '/d', executionHostId: 'local' }
      ],
      worktreeMeta: {}
    })
    expect(repos.map((repo) => repo.path)).toEqual(['/d'])
  })

  it('키 모양이 다르거나 파일이 이상하면 조용히 비운다', () => {
    expect(parseOrca(null)).toEqual([])
    expect(parseOrca({ repos: 'nope' })).toEqual([])
    const repos = parseOrca({
      repos: [{ id: 'r1', path: '/a' }],
      worktreeMeta: { 'r1::relative/path': {}, broken: {}, 'r1::': {} }
    })
    expect(repos[0].workspaces).toEqual([])
  })
})
