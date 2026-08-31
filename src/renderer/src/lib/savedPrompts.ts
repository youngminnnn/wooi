/**
 * 고른 프롬프트를 이미 쓰고 있던 글에 얹는다.
 *
 * 비어 있으면 그대로 채우고, 아니면 빈 줄을 두고 뒤에 붙인다 — 규칙 하나로 끝나고 사용자가
 * 친 글을 어느 경우에도 지우지 않는다.
 */
export function appendPrompt(current: string, prompt: string): string {
  return current.trim() ? `${current.replace(/\s+$/, '')}\n\n${prompt}` : prompt
}
