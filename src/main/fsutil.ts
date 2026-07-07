import { openSync, writeSync, fsyncSync, closeSync, renameSync, appendFileSync } from 'node:fs'
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
export function writeFileAtomic(filePath: string, data: string): void {
  const tmp = `${filePath}.tmp`
  const fd = openSync(tmp, 'w')
  try {
    writeSync(fd, data, null, 'utf-8')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
  renameSync(tmp, filePath)
  fsyncDir(dirname(filePath))
}

/**
 * 파일 끝에 한 줄(이상)을 추가하고 fsync 로 디스크에 강제 반영한다.
 * 트랜스크립트처럼 append-only 로그를 즉시 내구화해, 직후 크래시·전원 차단에도 마지막 항목이
 * 페이지 캐시에만 남아 유실되는 일을 막는다. fsync 실패는 best-effort 로 무시한다(append 자체는 완료).
 */
export function appendFileDurable(filePath: string, data: string): void {
  appendFileSync(filePath, data, 'utf-8')
  try {
    const fd = openSync(filePath, 'r')
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
  } catch {
    // fsync 보강 실패는 무시 — append 는 이미 커밋됐고, 내구성만 best-effort 다.
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
