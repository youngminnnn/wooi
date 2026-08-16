import * as acp from '@agentclientprotocol/sdk'
import type { ModelOption } from '@shared/types'
import { requestExtension } from '../acp/ext'
import { spawnAcpProcess } from '../acp/process'

/** 동적 조회가 실패해도 설정 화면에 남기는 작은 Grok Build 모델 목록. */
export const GROK_MODELS: ModelOption[] = [
  { id: 'grok-build', label: 'Grok Build (2M context)' },
  { id: 'grok-4.1-fast', label: 'Grok 4.1 Fast (2M context)' }
]

interface GrokModelState {
  availableModels?: Array<{ modelId?: string; id?: string; name?: string }>
  currentModelId?: string
}

let cache: ModelOption[] | null = null

/** 조회가 끝나기를 기다리는 한도. 넘으면 정적 목록으로 답한다. */
const QUERY_TIMEOUT_MS = 10_000

/** 테스트·로그인 변경 뒤 다음 조회가 단명 프로세스를 다시 띄우도록 캐시를 비운다. */
export function invalidateGrokModels(): void {
  cache = null
}

/**
 * initialize 뒤 Grok 확장 모델 목록을 읽고 프로세스를 즉시 닫는다.
 *
 * **실패분은 캐시하지 않는다.** 구독이 없거나 로그인 전이면 조회가 실패하는데, 그때 정적 목록을
 * 캐시에 박아 두면 로그인을 마친 뒤에도 앱을 다시 켜기 전까지 진짜 목록이 안 나온다.
 */
export async function listModels(): Promise<ModelOption[]> {
  if (cache) return cache
  try {
    cache = await withTimeout(queryModels(), QUERY_TIMEOUT_MS)
    return cache
  } catch {
    return GROK_MODELS
  }
}

/**
 * 시간 제한. 없으면 목록 하나가 앱을 잡아 둔다 — `grok agent stdio` 는 인증이 필요할 때
 * 곧바로 죽지 않고 기다릴 수 있고, 그러면 이 promise 가 영영 안 풀린다.
 */
function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Grok model listing timed out')), ms)
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

/** 제품 이름을 드러내는 호출부를 위한 별칭. */
export const listGrokModels = listModels

async function queryModels(): Promise<ModelOption[]> {
  const handle = spawnAcpProcess({ command: 'grok', args: ['agent', 'stdio'] })
  const app = acp
    .client({ name: 'wooi-model-probe' })
    // 모델 조회 중 권한 요청은 오지 않지만, 역요청 표면은 닫히지 않게 명시적으로 거절한다.
    .onRequest(acp.methods.client.session.requestPermission, (ctx) => ({
      outcome: { outcome: 'cancelled' },
      _meta: ctx.params._meta
    }))
  const connection = app.connect(handle.stream)
  try {
    await connection.agent.request(acp.methods.agent.initialize, {
      protocolVersion: acp.PROTOCOL_VERSION,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } }
    })
    const result = await requestExtension<GrokModelState>(connection.agent, 'x.ai/models/list', {})
    if (!result.supported) throw new Error('Grok model listing is unsupported')
    // 서버가 준 라벨은 그대로 쓴다. 컨텍스트 크기를 덧붙이지 않는 이유: 모델마다 다를 수 있는데
    // 전부에 `(2M context)` 를 붙이면 우리가 모르는 사실을 지어내는 셈이 된다. 정적 폴백
    // (GROK_MODELS)에만 확인된 값을 적어 둔다.
    const models = (result.value.availableModels ?? [])
      .map((model) => ({
        id: model.modelId ?? model.id ?? '',
        label: model.name ?? model.modelId ?? model.id ?? ''
      }))
      .filter((model) => model.id)
    return models.length ? models : GROK_MODELS
  } finally {
    connection.close()
    handle.dispose()
  }
}
