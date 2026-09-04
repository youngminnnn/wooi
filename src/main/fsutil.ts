import {
  openSync,
  writeSync,
  fsyncSync,
  fchmodSync,
  closeSync,
  renameSync,
  appendFileSync
} from 'node:fs'
import { dirname } from 'node:path'

/**
 * 파일을 원자적·내구성 있게 쓴다 — 임시 파일에 기록 후 fsync 로 디스크에 강제 반영하고,
 * rename 으로 교체한 뒤 디렉토리도 fsync 한다.
 *
 * 같은 디렉토리(=같은 볼륨) 내 rename 은 원자적이므로 쓰기 도중 크래시·전원 차단이 나도
 * 대상 파일이 반쪽 상태로 손상되지 않는다(직전 내용이 그대로 남는다). 추가로 fsync 까지 하면
 * OS 페이지 캐시에만 남고 디스크에는 안 내려간 상태에서의 전원 차단(= rename 은 보였는데 내용은
 * 유실)도 막는다. 설정([[store]])·트랜스크립트([[transcripts]]) 처럼 손상되면 안 되는 데이터에 쓴다.
 */
export function writeFileAtomic(filePath: string, data: string, opts?: { mode?: number }): void {
  const tmp = `${filePath}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, data, null, 'utf-8')
    // 임시 파일은 umask 가 깎은 기본 권한으로 생기므로, 원본의 권한을 물려받아야 할 때는
    // 여기서 명시적으로 맞춘다 — 안 하면 실행 가능한 스크립트를 뷰어에서 고쳐 저장하는
    // 순간 +x 가 조용히 떨어져 나간다. open 의 mode 인자는 umask 에 다시 깎이므로 못 쓴다.
    if (opts?.mode !== undefined) fchmodSync(fd, opts.mode)
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, filePath)
  fsyncDir(dirname(filePath))
}

/**
 * fsync 를 모으는 창. 이 시간 안에 같은 파일로 들어온 append 들은 fsync 한 번을 공유한다.
 */
const SYNC_DEBOUNCE_MS = 500

/** fsync 가 예약된 파일들(경로 → 타이머). */
const pendingSyncs = new Map<string, ReturnType<typeof setTimeout>>()

/**
 * 파일 끝에 한 줄(이상)을 추가하고, 뒤이어 fsync 로 디스크에 내린다.
 *
 * **append 는 즉시, fsync 는 모아서** 한다. append 자체는 싸지만 fsync 는 ~4ms 동안 메인
 * 스레드를 붙잡는다 — 트랜스크립트 항목마다 이걸 하면, 세션 여러 개가 동시에 응답을 쏟을 때
 * 메인이 fsync 로 포화되어 IPC 와 창 이벤트가 통째로 밀린다.
 *
 * 늦춰지는 것은 "디스크에 확실히 내려갔는가" 뿐이고, append 자체는 이미 커밋되어 OS 가
 * 들고 있다 — 즉 앱이 죽어도 내용은 남고, OS 째로 죽는 경우(커널 패닉·전원 차단)에만
 * 마지막 0.5초가 위험하다. 그마저도 트랜스크립트는 줄 단위 JSONL 이라 잘린 줄은 읽을 때
 * 무시되므로([[parseJsonl]]) 파일이 못 쓰게 되지는 않는다.
 *
 * 종료 시에는 flushPendingSyncs() 로 남은 것을 마저 내린다.
 */
export function appendFileDurable(filePath: string, data: string): void {
  appendFileSync(filePath, data, 'utf-8')

  if (pendingSyncs.has(filePath)) return
  const timer = setTimeout(() => {
    pendingSyncs.delete(filePath)
    syncFile(filePath)
  }, SYNC_DEBOUNCE_MS)
  // 이 타이머 때문에 프로세스가 살아 있을 이유는 없다.
  timer.unref?.()
  pendingSyncs.set(filePath, timer)
}

/** 예약된 fsync 를 전부 지금 수행한다(앱 종료 등 프로세스가 사라지기 직전에 호출). */
export function flushPendingSyncs(): void {
  for (const [filePath, timer] of pendingSyncs) {
    clearTimeout(timer)
    syncFile(filePath)
  }
  pendingSyncs.clear()
}

/** fsync 실패는 best-effort 로 무시한다(append 자체는 이미 커밋됐다). */
function syncFile(filePath: string): void {
  try {
    const fd = openSync(filePath, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    // 파일이 그 사이 지워졌거나(워크스페이스 삭제) fsync 미지원 — 무시한다.
  }
}

/** 디렉토리 엔트리(rename 결과)를 디스크에 내린다. 일부 플랫폼은 dir fsync 를 막으므로 best-effort. */
function fsyncDir(dir: string): void {
  try {
    const fd = openSync(dir, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    // 디렉토리 fsync 미지원/실패는 무시한다.
  }
}
