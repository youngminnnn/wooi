/**
 * diff 뷰어의 워드랩 on/off 가 만드는 클래스 차이를 한자리에 모은다.
 *
 * **이 값은 에디터의 워드랩과 절대 묶지 않는다.** 두 화면이 원하는 게 반대이기 때문이다 — 일반
 * 편집에서는 줄이 접혀야 화면 밖으로 안 새지만, diff 는 좌우 정렬이 곧 정보라서 접히는 순간 어느
 * 줄이 어느 줄과 짝인지 눈으로 못 따라간다. 나중에 에디터 워드랩이 생기더라도 각자의 값을 갖고,
 * 여기서 그 값을 읽지 않는다.
 *
 * 기본값은 **랩 켜짐**이다. 지금 Wooi 의 행이 이미 `whitespace-pre-wrap` 으로 접히고 있어서,
 * 기본을 뒤집으면 토글을 만든 적 없는 사용자의 화면까지 바뀐다. 정렬이 필요한 사람이 끄면 된다.
 *
 * 클래스 묶음을 모듈 상수로 얼려 두는 이유는 참조 안정성이다 — 매 렌더 새 객체를 만들면 이걸 받는
 * 쪽에서 memo 가 전부 무효가 된다.
 */
export interface DiffWrapClasses {
  /** hunk 본문을 감싸는 상자. 랩을 끄면 여기가 가로 스크롤을 맡는다. */
  body: string
  /** `@@ ... @@` 머리글. 가로로 밀어도 왼쪽에 붙어 있게 한다. */
  hunkHeader: string
  /** 한 행. 랩을 끄면 내용만큼 넓어지되 최소한 화면 폭은 채운다. */
  row: string
  /** 행의 코드 부분. */
  code: string
  /** 행 아래에 끼워 넣는 것(코멘트 입력 상자·카드)이 앉는 자리. */
  aside: string
}

/**
 * 랩 켜짐 — 지금까지의 모습 그대로. 가로 스크롤이 없으므로 `sticky` 도 필요 없다.
 *
 * `break-all` 은 공백 없는 긴 토큰(해시·base64)도 접기 위한 것이다.
 */
const WRAPPED: DiffWrapClasses = Object.freeze({
  body: 'bg-[var(--code-bg)] text-xs font-mono leading-[1.45]',
  hunkHeader: 'px-3 py-1 text-[var(--diff-hunk)] bg-[var(--surface)]/40',
  row: 'group/row flex',
  code: 'whitespace-pre-wrap break-all pr-3',
  aside: ''
})

/**
 * 랩 꺼짐 — 정렬을 지키고 넘치는 만큼 가로로 민다.
 *
 * 행에 `w-max min-w-full` 을 주는 게 핵심이다. `w-max` 만 주면 짧은 줄의 행 상자가 글자에서
 * 끝나 버려, 그 오른쪽 빈자리에서는 hover 가 안 잡히고(=드래그로 범위를 못 늘린다) 선택 배경도
 * 중간에서 끊긴다. `min-w-full` 로 최소한 화면 폭까지 늘려 두면 두 문제가 함께 사라진다.
 *
 * 머리글과 코멘트 자리는 `sticky left-0` 로 왼쪽에 붙여 둔다 — 오른쪽으로 밀어 놓은 채 코멘트를
 * 쓰려는데 입력 상자가 화면 밖에 있으면 곤란하다.
 */
const UNWRAPPED: DiffWrapClasses = Object.freeze({
  body: 'bg-[var(--code-bg)] text-xs font-mono leading-[1.45] overflow-x-auto',
  hunkHeader: 'sticky left-0 px-3 py-1 text-[var(--diff-hunk)] bg-[var(--surface)]/40',
  row: 'group/row flex w-max min-w-full',
  code: 'whitespace-pre pr-3',
  aside: 'sticky left-0'
})

/** 지금 랩 설정에 맞는 클래스 묶음. 같은 입력에는 같은 참조를 돌려준다. */
export function diffWrapClasses(wrap: boolean): DiffWrapClasses {
  return wrap ? WRAPPED : UNWRAPPED
}
