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
