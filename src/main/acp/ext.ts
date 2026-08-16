import { RequestError, type ClientContext } from '@agentclientprotocol/sdk'

const METHOD_NOT_FOUND = -32601

export type AcpExtensionResult<T> =
  { supported: true; value: T } | { supported: false; reason: 'method_not_found' }

/** JSON-RPC `method_not_found` 인가. 다른 실패와 섞지 않아 기능만 런타임에 내릴 수 있게 한다. */
export function isMethodNotFoundError(error: unknown): boolean {
  return error instanceof RequestError
    ? error.code === METHOD_NOT_FOUND
    : Boolean(
        error &&
        typeof error === 'object' &&
        'code' in error &&
        (error as { code?: unknown }).code === METHOD_NOT_FOUND
      )
}

/** 확장 요청을 보내고, 미지원만 값으로 돌려주며 실제 실행 실패는 그대로 던진다. */
export async function requestExtension<Response, Params = unknown>(
  context: ClientContext,
  method: string,
  params?: Params
): Promise<AcpExtensionResult<Response>> {
  try {
    return { supported: true, value: await context.request<Response, Params>(method, params) }
  } catch (error) {
    if (isMethodNotFoundError(error)) return { supported: false, reason: 'method_not_found' }
    throw error
  }
}
