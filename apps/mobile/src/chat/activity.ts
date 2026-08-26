import type { ChatRowModel } from './rows'

/**
 * 지금 에이전트가 무엇을 하고 있는지 한 줄로. 컴포저 위에 띄운다.
 *
 * 이게 없으면 **에이전트가 도구만 돌리는 동안 화면에 아무 신호가 없다.** 답을 쓰는 중이면
 * 글자가 늘어나는 게 보이고 생각 중이면 카드가 생기지만, 파일을 읽거나 명령을 돌리는 구간은
 * 대화가 멈춘 것과 구별되지 않는다. 폰에서는 그 차이를 확인하러 랩탑으로 돌아가는 비용이 크다.
 *
 * 가장 최근 행 하나만 본다. 그 뒤는 이미 지나간 일이라 "지금"에 답하지 못한다.
 */
export function activityLabel(rows: readonly ChatRowModel[], running: boolean): string | null {
  if (!running) return null
  // rows 는 newest-first 다(FlatList 의 inverted 계약).
  const latest = rows[0]
  if (latest === undefined) return 'Working…'

  if (latest.kind === 'tool') {
    // 결과가 아직 없는 도구의 title 은 이미 진행형 문구다("Reading a.ts") — rows.ts 의
    // makeToolCard 가 toolActivity 로 짓는다. 여기서 같은 말을 다시 지어내지 않는다.
    return latest.card.result === undefined ? latest.card.title : 'Working…'
  }

  if (latest.kind === 'tool-group') {
    // 묶음 안은 시간 순이다. 여럿이 동시에 돌 때는 마지막에 시작한 것이 지금에 가장 가깝다.
    for (let index = latest.cards.length - 1; index >= 0; index -= 1) {
      const card = latest.cards[index]
      if (card.result === undefined) return card.title
    }
    return 'Working…'
  }

  const item = latest.item
  // 답을 쓰는 중이면 커서가 이미 그 말을 하고 있다(RichText 의 streaming). 두 번 말하지 않는다.
  if (item.type === 'assistant' && item.streaming === true) return null
  if (item.type === 'thinking' && item.streaming === true) return 'Thinking…'
  return 'Working…'
}
