import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { AGENT_BACKEND_IDS } from '@shared/types'
import { WOOI_COMMAND_NAMESPACE, wooiCommandsFor } from '@shared/wooiCommands'
import { AGENT_TOOLS, agentToolsFor, delegateToolSpecs } from './catalog'

/**
 * `docs/built-in-mcp.md` 가 카탈로그와 갈라지지 못하게 막는 게이트.
 *
 * 스키마는 코드가 곧 진실이라 드리프트가 없지만, 그 옆의 **사람이 읽는 문서**는 손으로 쓴다.
 * 도구를 더하고 문서를 잊으면 아무도 모르는 채로 틀린 문서가 남고, 그것을 두 부류가 읽는다 —
 * 사용자(README 가 이 문서를 "모든 도구의 레퍼런스" 로 가리킨다)와 **Wooi 를 고치는 에이전트**다.
 * 후자는 틀린 전제 위에 설계를 얹으므로 값이 더 비싸다.
 *
 * 잡으려는 것은 한 부류다 — "도구(또는 커맨드)를 더했는데 문서에 없음". 스키마 전체를 파싱해
 * 문서 표와 대조하지는 않는다. 그건 유지비가 이득을 넘고, 인자 설명이 바뀔 때마다 무고하게
 * 깨지는 테스트는 결국 느슨해진다.
 */

interface DocFixture {
  /** 실패 메시지에 그대로 실린다. 리포 루트 기준 경로여야 사용자가 바로 연다. */
  path: string
  text: string
  /** 핵심 도구 개수를 본문에 적어 둔 자리. 언어마다 문장이 달라 문서별로 둔다. */
  countPattern: RegExp
}

function loadDoc(path: string, countPattern: RegExp): DocFixture {
  return {
    path,
    text: readFileSync(fileURLToPath(new URL(`../../../../${path}`, import.meta.url)), 'utf8'),
    countPattern
  }
}

// 영문과 한국어를 함께 본다. 짝 문서를 빼 두면 번역본만 조용히 낡는데, 그건 애초에 이 테스트가
// 막으려던 실패와 같은 모양이다.
const DOCS = [
  loadDoc('docs/built-in-mcp.md', /The (\d+) core tools/),
  loadDoc('docs/built-in-mcp.ko.md', /핵심 도구 (\d+)개/)
]

/**
 * 문서가 도구에 내준 `### \`이름\`` 절의 이름들.
 *
 * 본문 아무 데나 이름이 스쳐도 통과시키지 않는다 — 도구에는 인자와 제약을 적을 **자기 절**이
 * 있어야 하고, 백틱 헤딩은 문서가 이미 지키고 있는 규약이다.
 */
function documentedSections(doc: DocFixture): string[] {
  return [...doc.text.matchAll(/^#{2,3} `([a-z][a-z0-9_]*)`$/gm)].map((m) => m[1])
}

/**
 * `- \`이름\`` 목록 항목으로 올라 있는가. 절을 공유하는 도구용.
 *
 * 본문 아무 데나 이름이 스쳐도 되는 것으로 두면 검사가 사실상 없어진다 — 슬래시 명령 절이
 * `claude_subagent`·`codex_subagent` 를 산문으로 한 번 더 부르고 있어, 정작 목록에서 지워도
 * 통과한다. 목록 항목을 요구해야 "백엔드가 늘면 목록도 는다" 를 실제로 강제한다.
 */
function listed(doc: DocFixture, name: string): boolean {
  return new RegExp(`^- \`${name}\`$`, 'm').test(doc.text)
}

describe('built-in MCP reference', () => {
  for (const doc of DOCS) {
    describe(doc.path, () => {
      it('gives every core tool its own section', () => {
        const sections = documentedSections(doc)
        for (const tool of AGENT_TOOLS) {
          expect(
            sections,
            `${tool.name} is missing from ${doc.path} — add a "### \`${tool.name}\`" section ` +
              'describing what it does, its inputs, and its constraints.'
          ).toContain(tool.name)
        }
      })

      it('documents the subagent tools that only team mode gets', () => {
        // 조건부라고 빼지 않는다. 팀 워크스페이스의 에이전트에게는 이것도 그냥 도구이고,
        // 백엔드가 하나 늘면 "Optional subagent tools" 목록도 같이 늘어야 한다. 다만 두 도구는
        // 스키마가 같아 문서가 한 절을 공유하므로, 절 대신 그 절의 목록 항목을 요구한다.
        for (const spec of delegateToolSpecs(AGENT_BACKEND_IDS)) {
          expect(
            listed(doc, spec.name),
            `${spec.name} is missing from ${doc.path} — add a "- \`${spec.name}\`" bullet to ` +
              'the optional subagent tools list.'
          ).toBe(true)
        }
      })

      it('has no section for a tool that no longer exists', () => {
        // 반대 방향. 사라진 도구가 문서에 남으면 에이전트는 없는 도구를 부르려 든다.
        // 헤딩만 본다 — 본문에는 도구가 아닌 snake_case 낱말(`workspaceId` 인자 이름 등)이
        // 섞여 있어 전문(全文) 대조는 오탐을 낸다. 그래서 절이 없는 서브에이전트 도구는 이
        // 방향으로 못 잡는데, 오탐 없이 잡을 방법이 없는 쪽을 포기하는 편이 낫다 — 오탐 한 번이면
        // 다음 사람이 이 테스트를 느슨하게 만든다.
        const names = new Set(agentToolsFor(AGENT_BACKEND_IDS).map((t) => t.name))
        for (const section of documentedSections(doc)) {
          expect(
            names,
            `${doc.path} documents "${section}", which is not a Wooi tool — delete that section ` +
              'or rename it to the tool it meant.'
          ).toContain(section)
        }
      })

      it('lists every slash command, and only real ones', () => {
        // 커맨드는 도구의 사람 쪽 입구이고, 문서에는 그 대응표가 있다. 커맨드 이름은
        // `/wooi:` 접두사로 명확히 잡히므로 양방향이 싸다.
        const real = new Set(
          wooiCommandsFor(AGENT_BACKEND_IDS).map((c) => `/${WOOI_COMMAND_NAMESPACE}:${c.name}`)
        )
        const written = new Set(
          [...doc.text.matchAll(new RegExp(`/${WOOI_COMMAND_NAMESPACE}:[\\w-]+`, 'g'))].map(
            (m) => m[0]
          )
        )
        for (const command of real) {
          expect(
            written,
            `${command} is missing from ${doc.path} — add it to the slash command table.`
          ).toContain(command)
        }
        for (const command of written) {
          expect(
            real,
            `${doc.path} mentions ${command}, which is not a Wooi command — fix or remove it.`
          ).toContain(command)
        }
      })

      it('states the current number of core tools', () => {
        // 문서가 개수를 글로 적어 두었다. 절만 맞추고 이 숫자를 두면 문서가 스스로를 부정한다.
        const written = doc.countPattern.exec(doc.text)
        expect(
          written,
          `${doc.path} no longer states how many core tools there are, or the wording changed — ` +
            `update the sentence, or the countPattern in this test.`
        ).not.toBeNull()
        expect(
          Number(written?.[1]),
          `${doc.path} says there are ${written?.[1]} core tools, but there are ` +
            `${AGENT_TOOLS.length} — update the sentence.`
        ).toBe(AGENT_TOOLS.length)
      })
    })
  }
})
