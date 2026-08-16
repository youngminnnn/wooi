import { describe, expect, it, vi } from 'vitest'
import { CodexSkillsCache, mergeSkillCommands } from './skills'
import type { SkillsListResponse } from './wire'

function response(
  skills: SkillsListResponse['data'][number]['skills'],
  errors: SkillsListResponse['data'][number]['errors'] = []
): SkillsListResponse {
  return { data: [{ cwd: '/wt', skills, errors }] }
}

describe('Codex skills 자동완성', () => {
  it('disabled skill 은 제외한다', async () => {
    const cache = new CodexSkillsCache(async () =>
      response([
        { name: 'on', path: '/on/SKILL.md', description: 'On', enabled: true, scope: 'repo' },
        { name: 'off', path: '/off/SKILL.md', description: 'Off', enabled: false, scope: 'user' }
      ])
    )
    expect((await cache.list('/wt')).map((skill) => skill.name)).toEqual(['on'])
  })

  it('Wooi 명령과 이름이 겹치면 기존 명령을 남긴다', () => {
    const commands = [{ name: 'wooi:report', description: 'Wooi report' }]
    const merged = mergeSkillCommands(commands, [
      {
        name: 'wooi:report',
        path: '/skill/SKILL.md',
        description: 'Shadow',
        enabled: true,
        scope: 'repo'
      }
    ])
    expect(merged).toEqual(commands)
  })

  it('entry 에 parse error 가 있어도 정상 skill 을 돌려준다', async () => {
    const cache = new CodexSkillsCache(async () =>
      response(
        [
          {
            name: 'good',
            path: '/good/SKILL.md',
            description: 'Good',
            enabled: true,
            scope: 'user'
          }
        ],
        [{ path: '/bad/SKILL.md', message: 'invalid frontmatter' }]
      )
    )
    expect((await cache.list('/wt')).map((skill) => skill.name)).toEqual(['good'])
  })

  it('캐시 중에는 재조회하지 않고 change invalidation 뒤 한 번만 다시 조회한다', async () => {
    const fetch = vi.fn(async () => response([]))
    const cache = new CodexSkillsCache(fetch)
    await Promise.all([cache.list('/wt'), cache.list('/wt')])
    expect(fetch).toHaveBeenCalledTimes(1)

    cache.invalidate()
    await Promise.all([cache.list('/wt'), cache.list('/wt')])
    expect(fetch).toHaveBeenCalledTimes(2)
  })
})
