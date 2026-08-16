import { describe, expect, it } from 'vitest'
import { toPluginDetail, toPluginInventory } from './plugins'
import type { PluginsResponse } from './wire'

/**
 * 여기 쓰인 payload 는 전부 codex-cli 0.146.0 의 실제 `plugin/installed` · `plugin/read` 응답에서
 * 필요한 필드만 남긴 것이다. 지어낸 모양으로 시험하면 "우리가 이해한 대로" 만 고정되고 실물과
 * 어긋난다 — 이 파일이 잡아야 하는 것은 그 어긋남이다.
 */

function response(marketplaces: PluginsResponse['marketplaces']): PluginsResponse {
  return { marketplaces, marketplaceLoadErrors: [] }
}

describe('Codex 플러그인 인벤토리', () => {
  it('미지원 codex(-32601 → undefined)는 빈 목록이 아니라 supported:false 다', () => {
    expect(toPluginInventory(undefined)).toEqual({
      supported: false,
      marketplaces: [],
      loadErrors: []
    })
  })

  it('플러그인이 하나도 없어도 지원 자체는 true 다', () => {
    expect(toPluginInventory(response([]))).toEqual({
      supported: true,
      marketplaces: [],
      loadErrors: []
    })
  })

  it('로컬 마켓플레이스의 요약을 화면이 읽는 모양으로 옮긴다', () => {
    const inventory = toPluginInventory(
      response([
        {
          name: 'plugins-cli',
          path: '/Users/me/.agents/plugins/marketplace.json',
          interface: { displayName: 'Plugins CLI' },
          plugins: [
            {
              id: 'supabase@plugins-cli',
              name: 'supabase',
              installed: true,
              enabled: true,
              localVersion: '0.1.14',
              version: null,
              availability: 'AVAILABLE',
              source: { type: 'local', path: '/Users/me/.codex/plugins/cache/supabase' },
              interface: {
                displayName: 'Supabase',
                shortDescription: 'Supabase skills and MCP tools for Codex'
              }
            }
          ]
        }
      ])
    )

    expect(inventory.marketplaces).toEqual([
      {
        name: 'plugins-cli',
        displayName: 'Plugins CLI',
        path: '/Users/me/.agents/plugins/marketplace.json',
        plugins: [
          {
            id: 'supabase@plugins-cli',
            name: 'supabase',
            displayName: 'Supabase',
            description: 'Supabase skills and MCP tools for Codex',
            version: '0.1.14',
            enabled: true,
            source: 'local',
            sourceDetail: '/Users/me/.codex/plugins/cache/supabase',
            available: true,
            unavailableReason: null
          }
        ]
      }
    ])
  })

  // 원격 카탈로그는 경로가 없고 로컬 버전도 없다. 둘 다 실물에서 확인한 모양이다.
  it('원격 카탈로그는 path 가 null 이고 카탈로그 버전을 쓴다', () => {
    const [marketplace] = toPluginInventory(
      response([
        {
          name: 'openai-curated-remote',
          path: null,
          plugins: [
            {
              id: 'plugin-management@openai-curated-remote',
              name: 'plugin-management',
              enabled: true,
              version: '0.1.0',
              localVersion: null,
              source: { type: 'remote' },
              remotePluginId: 'plugin_connector_1p_b34'
            }
          ]
        }
      ])
    ).marketplaces

    expect(marketplace.path).toBeNull()
    expect(marketplace.displayName).toBe('openai-curated-remote')
    expect(marketplace.plugins[0]).toMatchObject({
      version: '0.1.0',
      source: 'remote',
      sourceDetail: ''
    })
  })

  it('enabled·availability 가 없으면 켜져 있고 쓸 수 있는 것으로 본다(codex 기본값)', () => {
    const [marketplace] = toPluginInventory(
      response([{ name: 'mp', plugins: [{ id: 'a@mp', name: 'a' }] }])
    ).marketplaces
    expect(marketplace.plugins[0]).toMatchObject({ enabled: true, available: true })
  })

  it('admin 이 막은 플러그인은 사람이 읽는 이유와 함께 쓸 수 없다고 표시한다', () => {
    const [marketplace] = toPluginInventory(
      response([
        {
          name: 'mp',
          plugins: [
            {
              id: 'a@mp',
              name: 'a',
              availability: 'DISABLED_BY_ADMIN',
              disabledReason: 'disabled_by_admin'
            }
          ]
        }
      ])
    ).marketplaces
    expect(marketplace.plugins[0]).toMatchObject({
      available: false,
      unavailableReason: 'Disabled by your workspace admin'
    })
  })

  // 스키마가 직접 밝힌 별칭이다 — plugin-service 는 'ENABLED' 를, app-server 는 'AVAILABLE' 을 쓴다.
  it("상류가 보내는 'ENABLED' 도 쓸 수 있는 상태로 본다", () => {
    const [marketplace] = toPluginInventory(
      response([{ name: 'mp', plugins: [{ id: 'a@mp', name: 'a', availability: 'ENABLED' }] }])
    ).marketplaces
    expect(marketplace.plugins[0].available).toBe(true)
  })

  it('모르는 이유 문자열은 삼키지 않고 그대로 보여 준다', () => {
    const [marketplace] = toPluginInventory(
      response([
        { name: 'mp', plugins: [{ id: 'a@mp', name: 'a', disabledReason: 'region_blocked' }] }
      ])
    ).marketplaces
    expect(marketplace.plugins[0]).toMatchObject({
      available: false,
      unavailableReason: 'region_blocked'
    })
  })

  it('git·npm 출처는 사람이 알아볼 한 줄로 접는다', () => {
    const [marketplace] = toPluginInventory(
      response([
        {
          name: 'mp',
          plugins: [
            {
              id: 'g@mp',
              name: 'g',
              source: { type: 'git', url: 'https://github.com/o/r', refName: 'main' }
            },
            {
              id: 'n@mp',
              name: 'n',
              source: { type: 'npm', package: '@scope/p', version: '1.2.3' }
            }
          ]
        }
      ])
    ).marketplaces
    expect(marketplace.plugins.map((plugin) => plugin.sourceDetail)).toEqual([
      'https://github.com/o/r#main',
      '@scope/p@1.2.3'
    ])
  })

  it('이름 없는 마켓플레이스·플러그인은 버린다(지칭할 방법이 없다)', () => {
    const inventory = toPluginInventory(
      response([
        { name: '', plugins: [{ id: 'x', name: 'x' }] },
        { name: 'mp', plugins: [{ id: 'a@mp' }, { id: 'b@mp', name: 'b' }] }
      ])
    )
    expect(inventory.marketplaces).toHaveLength(1)
    expect(inventory.marketplaces[0].plugins.map((plugin) => plugin.name)).toEqual(['b'])
  })

  it('읽지 못한 마켓플레이스는 경로와 메시지를 그대로 넘긴다', () => {
    const inventory = toPluginInventory({
      marketplaces: [],
      marketplaceLoadErrors: [{ marketplacePath: '/broken/marketplace.json', message: 'bad json' }]
    })
    expect(inventory.loadErrors).toEqual([
      { path: '/broken/marketplace.json', message: 'bad json' }
    ])
  })
})

describe('Codex 플러그인 상세', () => {
  it('응답이 없어도(미지원 버전) 빈 상세로 그린다', () => {
    expect(toPluginDetail(undefined)).toEqual({
      description: '',
      skills: [],
      mcpServers: [],
      hooks: [],
      apps: [],
      scheduledTasks: []
    })
  })

  it('스킬·앱 목록을 옮기고 이름 없는 항목은 버린다', () => {
    const detail = toPluginDetail({
      description: 'Access your Supabase projects',
      skills: [
        { name: 'supabase:supabase', description: 'Supabase tasks', enabled: true },
        { name: 'supabase:pg', description: 'Postgres', enabled: false },
        { description: '이름 없는 스킬' }
      ],
      mcpServers: [],
      apps: [{ id: 'asdk_app_1', name: 'Supabase', description: 'Manage Supabase projects' }],
      scheduledTasks: null
    })

    expect(detail.description).toBe('Access your Supabase projects')
    expect(detail.skills).toEqual([
      { name: 'supabase:supabase', description: 'Supabase tasks', enabled: true },
      { name: 'supabase:pg', description: 'Postgres', enabled: false }
    ])
    expect(detail.apps).toEqual([
      { id: 'asdk_app_1', name: 'Supabase', description: 'Manage Supabase projects' }
    ])
    expect(detail.scheduledTasks).toEqual([])
  })

  it('훅의 eventName 이 없어도 key 만으로 그린다', () => {
    expect(toPluginDetail({ hooks: [{ key: 'lint' }] }).hooks).toEqual([
      { key: 'lint', eventName: '' }
    ])
  })
})
