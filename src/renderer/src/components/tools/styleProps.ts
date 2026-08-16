import type { ReactNode } from 'react'

/**
 * 두 외형이 함께 받는 값. ToolCard 가 판단한 결과이며, 스타일 쪽은 이것을 그리기만 한다.
 *
 * 타입을 공유해 두면 한쪽에만 항목이 늘어나 두 스타일이 서로 다른 정보를 보여 주는 일이 없다.
 */
export interface ToolCardStyleProps {
  /** 사용자에게 보여 줄 도구 이름. */
  name: string
  /** 인자 한 줄 요약(파일 경로·명령어 등). */
  summary: string
  /** 실행 중일 때 요약 대신 쓸 현재진행형 문구. */
  activity: string
  pending: boolean
  /** 원시 입력(JSON)이 펼쳐져 있는가. */
  open: boolean
  toggle: () => void
  /** 파일을 바꾸는 도구의 증감 줄 수. 없으면 뱃지를 그리지 않는다. */
  stat: { added: number; removed: number } | null
  /** 짝지어진 결과. 아직 안 왔으면 없다. */
  result?: ReactNode
  details: ReactNode
  children?: ReactNode
}

/** 그룹도 내용은 한 번만 정하고 두 외형은 같은 값을 그린다. */
export interface ToolGroupStyleProps {
  label: string
  hint?: string
  active: boolean
  open: boolean
  toggle: () => void
  children?: ReactNode
}
