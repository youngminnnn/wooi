/**
 * push 로 값을 넣고 async iteration 으로 빼는 단방향 큐.
 * Claude Agent SDK 의 streaming input (장수명 query 에 사용자 메시지를 시간차로 흘려보냄)에 쓴다.
 * 소비자는 다음 값이 없으면 push 될 때까지 대기한다.
 */
export class AsyncQueue<T> {
  private values: T[] = []
  private resolvers: Array<(result: IteratorResult<T>) => void> = []
  private closed = false

  push(value: T): void {
    if (this.closed) return
    const resolve = this.resolvers.shift()
    if (resolve) {
      resolve({ value, done: false })
    } else {
      this.values.push(value)
    }
  }

  /** 큐가 닫혔는지(= 세션이 dispose 됐는지). 죽은 query 를 자동 재시도해도 되는지 판단에 쓴다. */
  get isClosed(): boolean {
    return this.closed
  }

  /**
   * 아직 소비되지 않은 값을 모두 꺼낸다. 죽은 query 를 재시도할 때 큐를 새 것으로 갈아 끼우면서
   * 남은 입력을 이월하는 데 쓴다 — 버려진 소비자(중단된 async iterator)가 이후 push 를 가로채는
   * 것을 막으려면 큐 자체를 교체해야 하기 때문이다.
   */
  drain(): T[] {
    const rest = this.values
    this.values = []
    return rest
  }

  /** 큐를 닫는다. 대기 중인 소비자는 done 으로 종료된다. */
  close(): void {
    this.closed = true
    while (this.resolvers.length) {
      this.resolvers.shift()!({ value: undefined as never, done: true })
    }
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      if (this.values.length) {
        yield this.values.shift()!
        continue
      }
      if (this.closed) return
      const result = await new Promise<IteratorResult<T>>((resolve) => {
        this.resolvers.push(resolve)
      })
      if (result.done) return
      yield result.value
    }
  }
}
