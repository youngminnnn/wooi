import { describe, it, expect, vi } from 'vitest'
import { createWooiMcpServer } from './wooiMcp'
import { AGENT_TOOLS, WOOI_MCP_SERVER_NAME } from '../agent/tools/catalog'

/**
 * 여기서는 SDK 를 모킹하지 않는다 — 검증하려는 것이 바로 SDK 사용법(createSdkMcpServer 와
 * zod raw shape 를 받는 tool())이기 때문이다. 모킹하면 정작 틀리기 쉬운 부분이 통과한다.
 *
 * 실행되는 도구가 카탈로그와 어긋나는 것은 조용한 실패다: 모델에게는 도구가 보이는데 부르면
 * 매번 "Unknown Wooi tool" 이 돌아온다.
 */

describe('createWooiMcpServer', () => {
  it('카탈로그의 도구를 모두 실은 sdk 서버를 만든다', () => {
    const server = createWooiMcpServer(async () => null)

    expect(server.type).toBe('sdk')
    expect(server.name).toBe(WOOI_MCP_SERVER_NAME)
    expect(server.instance).toBeTruthy()
    expect(AGENT_TOOLS.length).toBeGreaterThan(0)
  })

  it('도구 이름은 카탈로그와 정확히 같다', () => {
    // 이름이 어긋나면 메인의 실행부가 찾지 못한다(등록은 카탈로그 이름으로 한다).
    const names = AGENT_TOOLS.map((t) => t.name)
    expect(new Set(names).size).toBe(names.length)
    for (const name of names) {
      expect(name).toMatch(/^[a-z][a-z0-9_]*$/)
    }
  })

  it('모든 도구에 설명과 스키마가 있다', () => {
    for (const spec of AGENT_TOOLS) {
      expect(spec.description.length).toBeGreaterThan(40)
      expect(spec.inputSchema).toBeTypeOf('object')
    }
  })

  /**
   * 상시 로딩은 정의를 **모든 워크스페이스가 매 요청** 내므로, 하나 켜는 것이 곧 전 사용자에게
   * 걷는 세금이다. 기본 목록은 비어 있다 — check_related_work 가 한때 유일한 예외였는데, 상시
   * 비용과 "묻지도 않았는데 도는" 호출이 값보다 커서 지연 로딩으로 되돌렸다([[catalog]]).
   *
   * 그래서 이 테스트가 잡으려는 것은 한 방향이다: 켜는 쪽이 조용히 늘어나는 것. 켤 이유가
   * 생겼다면 여기 이름을 적으며 그 비용을 명시적으로 받아들이게 한다.
   */
  it('기본 도구는 아무것도 상시 로딩하지 않는다', () => {
    const always = AGENT_TOOLS.filter((t) => t.alwaysLoad).map((t) => t.name)
    expect(always).toEqual([])
  })
})

describe('isReadOnlyWooiTool', () => {
  it('접두사가 붙은 전체 이름으로 판단한다', async () => {
    const { isReadOnlyWooiTool } = await import('../agent/tools/catalog')
    // 남의 MCP 서버 도구가 우연히 같은 이름을 써도 자동 승인되면 안 된다.
    expect(isReadOnlyWooiTool('create_stacked_workspace')).toBe(false)
    expect(isReadOnlyWooiTool('mcp__other__create_stacked_workspace')).toBe(false)
    // 쓰기 도구는 승인 경로를 그대로 타야 한다.
    expect(isReadOnlyWooiTool('mcp__wooi__create_stacked_workspace')).toBe(false)
    expect(isReadOnlyWooiTool('Bash')).toBe(false)
  })
})

describe('도구 호출', () => {
  it('메인으로 이름과 인자를 그대로 넘기고 결과를 JSON 으로 돌려준다', async () => {
    const callTool = vi.fn().mockResolvedValue({ branch: 'feat/next' })
    const server = createWooiMcpServer(callTool)

    const result = await invoke(server, 'create_stacked_workspace', { name: 'feat/next' })

    expect(callTool).toHaveBeenCalledWith('create_stacked_workspace', { name: 'feat/next' })
    expect(result.content[0].text).toBe(JSON.stringify({ branch: 'feat/next' }))
  })
})

/** SDK 가 등록한 핸들러를 서버 인스턴스에서 끄집어내 직접 부른다. */
async function invoke(
  server: ReturnType<typeof createWooiMcpServer>,
  name: string,
  args: Record<string, unknown>
): Promise<{ content: Array<{ text: string }> }> {
  const registered = (
    server.instance as unknown as {
      _registeredTools: Record<string, { handler: (a: unknown, e: unknown) => Promise<unknown> }>
    }
  )._registeredTools
  expect(Object.keys(registered)).toContain(name)
  return registered[name].handler(args, {}) as Promise<{ content: Array<{ text: string }> }>
}
