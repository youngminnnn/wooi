/**
 * 도구 결과의 표준 바이너리 content block을 사람이 읽을 수 있는 짧은 문구로 바꾼다.
 * base64 본문은 화면에도 트랜스크립트에도 쓸모가 없고 기록만 크게 만들므로 반환하지 않는다.
 */
export function binaryContentPlaceholder(value: unknown): string | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null
  const block = value as Record<string, unknown>
  const type = typeof block.type === 'string' ? block.type : ''

  if (type === 'image' || type === 'inputImage' || type === 'input_image') {
    return placeholder('Image', mediaType(block))
  }
  if (type === 'audio' || type === 'inputAudio' || type === 'input_audio') {
    return placeholder('Audio', mediaType(block))
  }
  if (type === 'resource') {
    const resource = record(block.resource)
    if (resource && typeof resource.blob === 'string') {
      return placeholder('Binary resource', mediaType(resource))
    }
  }
  return null
}

function placeholder(label: string, media: string | null): string {
  return `[${label} content omitted${media ? ` (${media})` : ''}]`
}

function mediaType(value: Record<string, unknown>): string | null {
  const source = record(value.source)
  for (const candidate of [value.mimeType, value.mediaType, value.media_type, source?.media_type]) {
    if (typeof candidate === 'string' && candidate) return candidate
  }
  return null
}

function record(value: unknown): Record<string, unknown> | null {
  return value != null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null
}
