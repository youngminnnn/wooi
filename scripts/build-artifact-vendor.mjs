#!/usr/bin/env node
/**
 * 아티팩트 벤더 번들(`out/artifact/v/*.js`)을 필요할 때만 굽는다.
 *
 * `npm run dev` 마다 10초 넘게 쓰지 않기 위한 가드다. 산출물이 입력보다 새것이면 다시 구울
 * 이유가 없다. `--force` 로 무조건 굽는다(빌드·배포 경로가 쓴다).
 *
 * `package-lock.json` 이 입력에 **반드시 들어가야 한다.** 번들 안에 들어가는 것은 결국
 * `node_modules` 의 라이브러리이므로, 설정과 엔트리만 보면 의존성만 오른 경우를 놓친다 —
 * 그러면 recharts 를 올려 놓고 옛 recharts 를 실은 번들을 조용히 배포하게 된다. 실제로
 * 리베이스로 lucide-react 가 1.31 → 1.38 로 오른 뒤 이 스크립트가 "up to date" 라고 답했다.
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const OUT = 'out/artifact/v/react.js'
const INPUTS = ['vite.artifact.config.ts', 'src/artifact/vendor', 'package-lock.json']

function newestInput() {
  let newest = 0
  for (const path of INPUTS) {
    const s = statSync(path)
    if (s.isDirectory()) {
      for (const name of readdirSync(path))
        newest = Math.max(newest, statSync(join(path, name)).mtimeMs)
    } else newest = Math.max(newest, s.mtimeMs)
  }
  return newest
}

const force = process.argv.includes('--force')
let fresh = false
if (!force) {
  try {
    fresh = statSync(OUT).mtimeMs >= newestInput()
  } catch {
    fresh = false
  }
}

if (fresh) console.log('artifact vendor bundle is up to date')
else execFileSync('npx', ['vite', 'build', '-c', 'vite.artifact.config.ts'], { stdio: 'inherit' })
