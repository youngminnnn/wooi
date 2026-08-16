import { ipcMain, type IpcMainInvokeEvent } from 'electron'

/**
 * IPC 핸들러 시그니처. 렌더러에서 오든 원격에서 오든 같은 함수를 탄다.
 *
 * args 를 `never[]` 로 둔 이유: 등록 측(registerIpc)은 채널마다 구체 타입으로 선언하고,
 * 레지스트리는 그 반공변(contravariant) 파라미터를 하나의 맵에 담기만 하면 되기 때문이다.
 * 실제 인자 검증은 호출 경로별 책임이다 — 렌더러는 preload 계약이, 원격은 remote/allowlist 가 한다.
 */
type Handler = (event: IpcMainInvokeEvent, ...args: never[]) => unknown

const handlers = new Map<string, Handler>()

/**
 * 원격 호출에 넘기는 합성 IpcMainInvokeEvent.
 *
 * **모든 프로퍼티 읽기에서 throw 한다.** 지금은 모든 핸들러가 event 를 쓰지 않지만(전수 확인),
 * 나중에 누가 `event.sender` 로 응답하거나 창을 특정하는 핸들러를 쓰면 원격 경로가 조용히
 * 다르게 동작하게 된다. 그런 코드는 첫 원격 호출에서 즉시 터지는 편이 낫다.
 *
 * 예외는 `then`(await 가 thenable 검사로 읽는다)과 심볼(`util.inspect.custom`,
 * `Symbol.toPrimitive` 등 로깅·형변환 경로)뿐이며, 둘 다 undefined 를 돌려준다.
 */
const REMOTE_EVENT = new Proxy({} as IpcMainInvokeEvent, {
  get(_target, prop) {
    if (prop === 'then' || typeof prop === 'symbol') return undefined
    throw new Error(`remote command read event.${String(prop)} — not available off-renderer`)
  }
})

/**
 * `ipcMain.handle` 의 드롭인 대체.
 *
 * 렌더러용 등록에 더해 레지스트리에도 남겨, 원격 브리지가 **같은 핸들러 함수**를 재사용하게 한다.
 * 이렇게 해야 원격 경로가 핸들러 안에 이미 있는 검증(carry 경로, reorder 형제 규칙, 브랜치 소속 …)과
 * 부작용(트랜스크립트 삭제, 상태 방송 …)을 그대로 상속한다 — 두 경로가 갈라지지 않는다.
 *
 * 레지스트리 등록은 **노출이 아니다**. 실제로 원격에서 부를 수 있는 채널은
 * `remote/allowlist.ts` 가 단독으로 결정한다(기본 거부).
 */
export function handle(channel: string, fn: Handler): void {
  handlers.set(channel, fn)
  ipcMain.handle(channel, fn as never)
}

/** 이 채널에 등록된 핸들러가 있는지. */
export function hasCommand(channel: string): boolean {
  return handlers.has(channel)
}

/**
 * 등록된 핸들러를 렌더러 밖에서 호출한다(원격 브리지 전용).
 *
 * 채널 허용 여부 검증은 **호출 측 책임**이다 — 이 함수는 등록 여부만 본다.
 * 반환값은 핸들러의 결과(비동기면 await 된 값)다.
 */
export async function invokeCommand(channel: string, args: readonly unknown[]): Promise<unknown> {
  const fn = handlers.get(channel)
  if (!fn) throw new Error(`unknown command channel: ${channel}`)
  return await (fn as (event: IpcMainInvokeEvent, ...a: unknown[]) => unknown)(
    REMOTE_EVENT,
    ...args
  )
}

/** 테스트 전용 — 등록 상태를 비운다. */
export function __resetRegistry(): void {
  for (const channel of handlers.keys()) ipcMain.removeHandler(channel)
  handlers.clear()
}

/** 테스트 전용 — 등록된 채널 이름 목록. */
export function __registeredChannels(): string[] {
  return [...handlers.keys()]
}
