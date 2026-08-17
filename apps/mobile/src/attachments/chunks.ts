import { REMOTE_UPLOAD_CHUNK_BYTES } from '@shared/remote'

/**
 * base64 문자열을 **그 자체로 유효한 base64 조각들**로 자른다.
 *
 * 바이트로 자른 뒤 조각마다 다시 인코딩하지 않는 이유는, RN 에는 Buffer 가 없어서 파일을
 * 읽는 순간 이미 base64 한 덩이로 손에 들어오기 때문이다. 대신 **4의 배수 위치에서만**
 * 자르면 각 조각이 온전한 3바이트 그룹으로 끝나므로 따로 인코딩하지 않아도 랩탑이 조각마다
 * 독립적으로 디코딩할 수 있다. 패딩(`=`)은 원본의 맨 끝에만 있으니 마지막 조각만 갖는다.
 *
 * (`REMOTE_UPLOAD_CHUNK_BYTES` 가 3의 배수여야 이 성질이 성립한다 — chunks.test.ts 가 지킨다.)
 */
export const CHUNK_BASE64_CHARS = (REMOTE_UPLOAD_CHUNK_BYTES / 3) * 4

export function chunkBase64(base64: string): string[] {
  const chunks: string[] = []
  for (let at = 0; at < base64.length; at += CHUNK_BASE64_CHARS) {
    chunks.push(base64.slice(at, at + CHUNK_BASE64_CHARS))
  }
  // 빈 입력은 조각이 없다. 빈 파일은 고를 때 걸러진다 — 여기서 빈 조각을 지어내면
  // 랩탑의 검증기가 "chunk must be a non-empty string" 으로 되받아 원인이 흐려진다.
  return chunks
}

/** base64 문자열이 나타내는 원본 바이트 수. 크기 상한을 판단할 때 쓴다. */
export function base64Bytes(base64: string): number {
  if (base64.length === 0) return 0
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  return (base64.length / 4) * 3 - padding
}
