let unrequestedTurnUsed = false

/** 이번 실행에서 사용자 입력 없이 시작할 수 있는 턴 하나를 가져간다. */
export function takeUnrequestedTurn(): boolean {
  if (unrequestedTurnUsed) return false
  unrequestedTurnUsed = true
  return true
}

/** 실행 하나의 공유 예산을 되돌린다. 프로덕션에서는 호출할 이유가 없고 테스트에서만 쓴다. */
export function resetResumeBudget(): void {
  unrequestedTurnUsed = false
}
