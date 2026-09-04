/* global console, process, document */

import { openSeededWorkspace, seedAppState, waitForInspection } from '../fixtures.mjs'
import { launchWooi, withScratchRepo } from '../harness.mjs'

/**
 * 상태줄이 한 줄에 들어가는지는 jsdom 이 증명하지 못한다 — 진짜 레이아웃과 진짜 CSS 가 필요하다.
 *
 * 두 가지를 고정한다:
 * - 값이 기본값인 칩(effort·fast·밀도)은 **라벨을 아예 그리지 않는다.** 아이콘과 클릭 대상은 남는다.
 * - 좁아지면 라벨이 정해진 차례로 접힌다. 이건 컨테이너 쿼리라, Tailwind 가 `@max-[…]:hidden`
 *   클래스를 만들어 내지 못하면 조용히 아무 일도 일어나지 않는다 — 그 실패를 여기서 잡는다.
 *
 * 그리고 어느 폭에서도 줄이 넘치지 않는지 본다(`scrollWidth <= clientWidth`).
 */
const CHIPS = {
  dir: '[title^="Directory:"]',
  model: '[title^="Model:"]',
  effort: '[title^="Reasoning effort:"]',
  fast: '[title^="Fast mode"]',
  density: '[title^="Conversation density:"]'
}

/** Composer.tsx 의 `HIDE_*` 와 같은 값이어야 한다 — 이 스펙이 그 상수의 계약이다. */
const HIDE_LABEL_BELOW = { dir: 520, agent: 480, density: 440, fast: 400, effort: 370, model: 340 }
/** 이 폭 아래에서는 칩을 통째로 버린다. */
const SLIVER = 340
/**
 * 재 볼 폭. 오른쪽 패널이 열려 있어 채팅 pane 은 `viewport - 751` 이고 이 줄은 거기서 32px 를
 * 더 뺀 값이다 — 아래 창 크기는 상태줄 폭 768 / 500 / 400 / 350 / 317 을 만든다.
 */
const VIEWPORTS = [1900, 1283, 1183, 1133, 1100]

async function probe(win, chips) {
  return win.evaluate((selectors) => {
    const line = document.querySelector('[data-status-line]')
    if (!line) throw new Error('status line was not rendered')
    const gap = parseFloat(globalThis.getComputedStyle(line).columnGap) || 0
    const shown = [...line.children].filter(
      (el) => globalThis.getComputedStyle(el).display !== 'none'
    )
    const out = {
      width: line.clientWidth,
      overflow: line.scrollWidth - line.clientWidth,
      // 칩이 자연히 차지하는 폭. flex 가 눌러 담은 뒤의 폭이 아니라 넘치는지를 보는 값이다.
      contentWidth: Math.round(
        shown.reduce((sum, el) => sum + el.scrollWidth, 0) + gap * Math.max(0, shown.length - 1)
      ),
      chips: {}
    }
    for (const [name, selector] of Object.entries(selectors)) {
      const chip = line.querySelector(selector)
      if (!chip) {
        out.chips[name] = null
        continue
      }
      const label = chip.querySelector('span')
      out.chips[name] = {
        title: chip.getAttribute('title'),
        // 칩 자체가 접혔는가(가장 좁을 때). 라벨만 접힌 것과 구별한다.
        chipHidden: globalThis.getComputedStyle(chip).display === 'none',
        // 라벨이 아예 없는 것(quiet)과 CSS 로 접힌 것(좁음)은 다른 상태다 — 따로 본다.
        hasLabel: !!label,
        labelText: label ? label.textContent.trim() : null,
        labelHidden: label ? globalThis.getComputedStyle(label).display === 'none' : null,
        clickable: chip.tagName === 'BUTTON',
        width: chip.getBoundingClientRect().width
      }
    }
    return out
  }, chips)
}

export default async function 상태줄이_한_줄에_들어간다() {
  await withScratchRepo(
    {
      worktrees: ['feature-test'],
      seed: (scratch) =>
        seedAppState(scratch, {
          // 모델은 명시한다 — 시드 기본값(null)은 "Default" 라 짧은 라벨을 검증할 수 없다.
          workspace: { model: 'claude-opus-5[1m]' }
        })
    },
    async (scratch) => {
      const wooi = await launchWooi({ appDir: process.cwd(), ...scratch })
      try {
        await openSeededWorkspace(wooi.win)
        await wooi.win.setViewportSize({ width: 1600, height: 900 })
        await wooi.win.locator('[data-status-line]').waitFor()

        const wide = await probe(wooi.win, CHIPS)
        if (wide.width < 700) throw new Error(`status line is not wide here: ${wide.width}px`)
        // 기본값만 있는 줄이 실제로 얼마나 되는지 기록해 둔다 — 이 스펙이 지키는 값의 근거다.
        console.log(`[e2e] quiet line content = ${wide.contentWidth}px of ${wide.width}px`)
        const wideShot = await wooi.shot('status-line-wide')
        if (wide.overflow > 1) throw new Error(`status line overflowed: ${JSON.stringify(wide)}`)

        // 모델은 짧게 적고 온전한 이름은 hover 로 남긴다.
        if (wide.chips.model?.labelText !== 'Opus 5 · 1M') {
          throw new Error(`model label was not compacted: ${JSON.stringify(wide.chips.model)}`)
        }
        if (!wide.chips.model.title.includes('Opus 5 (1M context)')) {
          throw new Error(`full model name left the tooltip: ${wide.chips.model.title}`)
        }

        // 기본값인 칩은 넓은 화면에서도 라벨을 그리지 않는다. 대신 여전히 누를 수 있다.
        for (const name of ['effort', 'fast', 'density']) {
          const chip = wide.chips[name]
          if (!chip) throw new Error(`${name} chip disappeared entirely`)
          if (chip.hasLabel) {
            throw new Error(
              `${name} still spends width on a default label: ${JSON.stringify(chip)}`
            )
          }
          if (!chip.clickable) throw new Error(`${name} chip is no longer clickable`)
        }

        // 기본값이 아니면 라벨이 돌아온다 — 대화가 성겨 보이는 이유를 화면이 말해야 하기 때문이다.
        await wooi.win.locator(CHIPS.density).click()
        await wooi.win.getByText('Verbose').click()
        await wooi.win.locator('[title^="Conversation density: Verbose"]').waitFor()
        const verbose = await probe(wooi.win, CHIPS)
        if (verbose.chips.density?.labelText !== 'Verbose') {
          throw new Error(
            `non-default density stayed silent: ${JSON.stringify(verbose.chips.density)}`
          )
        }

        // 좁히면 정해진 차례로 접힌다. 폭은 재서 쓰고, 기대값은 그 폭으로 계산한다 —
        // 창 크기가 아니라 이 줄 자신의 폭이 판단 근거이기 때문이다.
        const narrow = []
        for (const width of VIEWPORTS) {
          await wooi.win.setViewportSize({ width, height: 900 })
          const seen = await probe(wooi.win, CHIPS)
          narrow.push({ viewport: width, lineWidth: seen.width, overflow: seen.overflow })
          if (seen.overflow > 1) {
            throw new Error(`status line overflowed at ${width}px: ${JSON.stringify(seen)}`)
          }
          const sliver = seen.width < SLIVER
          for (const [name, threshold] of Object.entries(HIDE_LABEL_BELOW)) {
            const chip = seen.chips[name]
            // 가장 좁을 때 사라지는 칩(디렉터리)은 라벨을 따질 대상이 아니다.
            if (!chip || chip.chipHidden) {
              if (!sliver && name === 'dir') {
                throw new Error(`dir chip vanished at ${seen.width}px, above the sliver width`)
              }
              continue
            }
            if (!chip.hasLabel) continue
            const shouldHide = seen.width < threshold
            if (chip.labelHidden !== shouldHide) {
              throw new Error(
                `${name} label was ${chip.labelHidden ? 'hidden' : 'shown'} at line width ` +
                  `${seen.width}px (threshold ${threshold}px): ${JSON.stringify(chip)}`
              )
            }
          }
          // 가장 좁을 때도 이 줄에만 있는 값은 남는다 — 모델·밀도는 아이콘으로라도 살아 있어야 한다.
          if (seen.chips.model?.chipHidden !== false || seen.chips.density?.chipHidden !== false) {
            throw new Error(`status line lost its own values at ${seen.width}px`)
          }
          if (sliver && seen.chips.dir?.chipHidden !== true) {
            throw new Error(`dir chip survived into the sliver at ${seen.width}px`)
          }
          // 좁은 폭에서 진짜로 확인해야 하는 것 — 눌러 담은 결과가 아니라 자연 폭이 들어가는가.
          if (seen.contentWidth > seen.width) {
            throw new Error(
              `chips need ${seen.contentWidth}px but the line is ${seen.width}px wide`
            )
          }
        }

        // 폭은 오른쪽 패널이 연 채로 잡은 것이라 배치가 바뀌면 함께 어긋난다. 실제로 접기
        // 구간을 다 지났는지 여기서 확인한다 — 아니면 이 스펙은 조용히 아무것도 안 지키게 된다.
        const widths = narrow.map((step) => step.lineWidth)
        if (Math.max(...widths) < 520 || Math.min(...widths) >= SLIVER) {
          throw new Error(
            `viewports no longer span the fold range — line widths were ${JSON.stringify(widths)}`
          )
        }

        const screenshot = await wooi.shot('status-line-narrow')
        console.log(`[e2e] widths=${JSON.stringify(narrow)} shots=${wideShot},${screenshot}`)
        await waitForInspection(wooi.win)
      } finally {
        await wooi.close()
      }
    }
  )
}
