import { useMemo } from 'react'
import { authoredLines, type BranchLineTotal, type LineCount } from '@shared/codePaths'

/**
 * 브랜치 전체가 몇 줄을 더하고 뺐는지 — 단, **사람이 쓴 몫만** 앞에 세운다.
 *
 * 파일 단위 +/− 는 이미 있었지만 브랜치 합계가 없었다. 그런데 합계를 그냥 더하면 재생성된
 * lock 파일 3천 줄이 섞여, 정작 알고 싶은 "이 브랜치가 얼마나 썼나" 가 묻힌다. 그래서 생성
 * 코드와 테스트를 본 숫자에서 빼고, 뺀 몫은 감추는 대신 호버 내역으로 돌린다 — 갈라내는
 * 것과 숨기는 것은 다르다.
 */

const grouped = new Intl.NumberFormat()

/**
 * 스크린리더용 라벨은 **자릿수 구분 기호 없이** 만든다. 여러 로케일에서 리더가 "8,259" 를
 * 숫자 둘로 끊어 읽는다 — 화면의 8,259 와 귀에 들리는 값이 갈라지면 라벨이 없느니만 못하다.
 */
function spell(count: LineCount): string {
  return `${count.added} lines added, ${count.removed} lines deleted`
}

function Pair({ count }: { count: LineCount }): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap tabular-nums">
      <span className="text-[var(--success-400)]">+{grouped.format(count.added)}</span>
      <span className="text-[var(--danger-400)]">−{grouped.format(count.removed)}</span>
    </span>
  )
}

export default function BranchLineTotalChip({
  total
}: {
  total: BranchLineTotal
}): React.JSX.Element {
  const authored = useMemo(() => authoredLines(total), [total])
  const rows = useMemo(() => {
    const list: { key: string; label: string; count: LineCount }[] = [
      { key: 'source', label: 'Source', count: authored }
    ]
    // "테스트가 없는 브랜치" 는 +0 −0 으로 적어 줄 값이 있지만, "생성된 것이 없다" 는 평범한
    // 경우라 줄을 만들지 않는다.
    list.push({ key: 'test', label: 'Tests', count: total.test })
    if (total.generated.added > 0 || total.generated.removed > 0) {
      list.push({ key: 'generated', label: 'Generated', count: total.generated })
    }
    list.push({ key: 'total', label: 'Branch total', count: total })
    return list
  }, [authored, total])

  // 갈라낸 몫이 없으면 본 숫자가 곧 전체다 — 내역을 띄울 것도, 호버를 암시할 것도 없다.
  const split =
    total.test.added > 0 ||
    total.test.removed > 0 ||
    total.generated.added > 0 ||
    total.generated.removed > 0

  const label = useMemo(() => {
    if (!split) return `Branch total: ${spell(total)}`
    const parts = [`Source: ${spell(authored)}`]
    if (total.test.added > 0 || total.test.removed > 0) parts.push(`tests: ${spell(total.test)}`)
    if (total.generated.added > 0 || total.generated.removed > 0) {
      parts.push(`generated: ${spell(total.generated)}`)
    }
    parts.push(`branch total: ${spell(total)}`)
    return parts.join(', ')
  }, [authored, split, total])

  const chip = (
    <span role="group" aria-label={label} className="inline-flex items-center">
      <span aria-hidden="true" className={split ? 'border-b border-dashed border-neutral-600' : ''}>
        <Pair count={split ? authored : total} />
      </span>
    </span>
  )

  if (!split) return chip

  return (
    // 클릭 대상이 아니라는 신호로 cursor-help 를 쓴다. 패널은 포커스를 가져가지 않으므로
    // 보조 기술에는 위의 aria-label 로 같은 내용이 이미 전달돼 있다.
    <span className="group/total relative cursor-help">
      {chip}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-0 top-full z-10 mt-1 hidden min-w-[13rem] rounded-md border border-[var(--border)] bg-[var(--surface)] p-2 shadow-lg group-hover/total:block"
      >
        <span className="mb-1 block text-[10px] uppercase tracking-wide text-neutral-500">
          Lines of code
        </span>
        {rows.map((row) => (
          <span key={row.key} className="flex items-center justify-between gap-4 leading-5">
            <span className="text-neutral-400">{row.label}</span>
            <Pair count={row.count} />
          </span>
        ))}
      </span>
    </span>
  )
}
