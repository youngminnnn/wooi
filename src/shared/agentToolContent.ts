/**
 * 도구 실행 결과를 MCP 콘텐츠 블록으로 바꾼다.
 *
 * 결과는 거의 전부 JSON 한 덩어리라 두 전송 계층(Claude 의 인프로세스 서버, Codex 의 stdio shim)이
 * 각자 `JSON.stringify` 한 줄로 끝내고 있었다. 그런데 **그림을 돌려주는 도구**가 생기면 그 한 줄로는
 * 안 된다 — base64 를 JSON 문자열에 담아 보내면 모델에게는 그림이 아니라 수십만 자의 난수 텍스트가
 * 간다. 이미지는 반드시 `image` 블록이어야 한다.
 *
 * 그래서 변환을 여기 한 곳에 두고 두 전송 계층이 같이 쓴다. 전송 계층마다 따로 두면 한쪽에서만
 * 그림이 되고 다른 쪽에서는 조용히 텍스트가 된다.
 *
 * Electron 도, zod 도 필요 없는 순수 변환이라 shared/ 에 둔다.
 */

/** 결과에 그림 한 장을 실을 때 쓰는 키. 일반 필드와 부딪히지 않게 밑줄로 시작한다. */
export const AGENT_TOOL_IMAGE_KEY = '_image'

export interface AgentToolImage {
  dataBase64: string
  /** `image/png` 같은 MIME 타입. */
  mediaType: string
}

export type McpContentBlock =
  { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }

function imageOf(data: unknown): AgentToolImage | null {
  if (typeof data !== 'object' || data === null) return null
  const candidate = (data as Record<string, unknown>)[AGENT_TOOL_IMAGE_KEY]
  if (typeof candidate !== 'object' || candidate === null) return null
  const { dataBase64, mediaType } = candidate as Record<string, unknown>
  if (typeof dataBase64 !== 'string' || !dataBase64) return null
  if (typeof mediaType !== 'string' || !mediaType) return null
  return { dataBase64, mediaType }
}

/**
 * 결과를 콘텐츠 블록으로 만든다. 이미지가 실려 있으면 그 키를 텍스트에서 **빼고** 별도 블록으로
 * 낸다 — 안 빼면 같은 base64 가 텍스트로 한 번 더 가서 값이 두 배가 된다.
 *
 * 텍스트를 먼저 두는 이유는 모델이 위에서부터 읽기 때문이다. 무엇을 찍은 그림인지(주소·크기·
 * 줄였는지)를 먼저 알고 그림을 봐야 한다.
 */
export function agentToolContent(data: unknown): McpContentBlock[] {
  const image = imageOf(data)
  if (!image) return [{ type: 'text', text: JSON.stringify(data ?? null) }]

  const rest = { ...(data as Record<string, unknown>) }
  delete rest[AGENT_TOOL_IMAGE_KEY]
  return [
    { type: 'text', text: JSON.stringify(rest) },
    { type: 'image', data: image.dataBase64, mimeType: image.mediaType }
  ]
}
