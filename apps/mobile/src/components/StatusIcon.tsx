import { ActivityIndicator, View } from 'react-native'
import {
  AlertTriangle,
  GitBranch,
  Hourglass,
  MessagesSquare,
  ShieldQuestion
} from 'lucide-react-native'
import type { RemoteWorkspace } from '@shared/remote'
import { usePrColors } from '../state/prColors'
import { useTheme } from '../state/theme'

/**
 * 워크스페이스 한 줄의 상태 표시.
 *
 * 데스크톱 사이드바의 `StatusDot` 과 **같은 아이콘·같은 우선순위**를 쓴다(lucide 세트도 같다).
 * 색만 다른 점을 늘어놓으면 무엇이 다른지 읽으려고 색을 외워야 하는데, 폰은 밝은 데서 보는
 * 일이 많아 그게 더 불리하다. 모양이 다르면 색을 못 봐도 구분된다.
 *
 * 우선순위: 권한·질문 대기 > 실행 중 > 사용량 제한 > 에러 > PR 상태 > idle.
 * 지금 행동할 수 있는 것이 앞이고, PR 은 아무 일도 일어나지 않을 때에야 말한다.
 */
export function StatusIcon({
  workspace,
  hasLimit,
  awaitingQuestion = false
}: {
  workspace: RemoteWorkspace
  hasLimit: boolean
  /** 대기 중인 것이 승인이 아니라 질문(AskUserQuestion)인가. */
  awaitingQuestion?: boolean
}): React.JSX.Element {
  const theme = useTheme()
  const prColors = usePrColors()

  if (workspace.attention === 'permission') {
    // 방패는 "허락할까요", 말풍선은 "답해 주세요" 다 — 상세 화면의 QuestionCard 가 쓰는
    // 아이콘과 같은 것을 써서, 목록에서 본 그림이 열었을 때 그대로 이어지게 한다.
    return awaitingQuestion ? (
      <MessagesSquare size={15} color={theme.accent} />
    ) : (
      <ShieldQuestion size={15} color={theme.accent} />
    )
  }
  if (workspace.status === 'running') {
    // 도는 것은 도는 것으로 보여야 한다 — 정지 아이콘은 "지금 일어나는 중"을 말하지 못한다.
    return <ActivityIndicator size="small" color={theme.info} />
  }
  if (hasLimit) return <Hourglass size={14} color={theme.warningFg} />
  if (workspace.status === 'error') return <AlertTriangle size={14} color={theme.danger} />

  // 남은 것은 idle 이다. PR 이 있으면 그 상태를 점 색으로 말하고, 없으면 조용한 점 하나.
  const color = workspace.pr ? (prColors[workspace.pr.state] ?? theme.textFaint) : theme.textFaint
  return <View style={{ backgroundColor: color, borderRadius: 5, height: 9, width: 9 }} />
}

/** 브랜치 한 줄 앞의 아이콘. 데스크톱 사이드바가 브랜치 이름 앞에 두는 것과 같다. */
export function BranchIcon(): React.JSX.Element {
  const theme = useTheme()
  return <GitBranch size={11} color={theme.textDim} />
}
