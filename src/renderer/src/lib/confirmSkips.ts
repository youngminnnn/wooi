import type { ConfirmSkipKey } from '@shared/types'

/**
 * "다시 묻지 않기" 로 끌 수 있는 확인의 사람이 읽는 이름.
 *
 * 설정 행과 저장 직후의 토스트가 같은 문구를 써야 한다 — 토스트에서 읽은 말과 설정에서 찾을
 * 말이 다르면, 되돌리는 길을 안내해 놓고도 못 찾게 된다.
 */
export const CONFIRM_SKIP_LABELS: Record<
  ConfirmSkipKey,
  { title: string; description: string; action: string }
> = {
  archiveWorkspace: {
    title: 'Ask before archiving a workspace',
    description: 'Archiving removes the worktree; the branch, pull request and conversation stay.',
    action: 'archiving a workspace'
  },
  archiveReview: {
    title: 'Ask before archiving a review',
    description: 'Archiving removes the worktree; the findings and conversation stay.',
    action: 'archiving a review'
  }
}
