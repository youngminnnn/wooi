/**
 * Wooi Remote — 키스토어 실물 검증.
 *
 * `keystore.test.ts` 는 `safeStorage` 를 목킹한다(CI 에 Keychain 이 없다). 그래서 **실제
 * OS 암호화 저장소로 왕복하는지**는 어디서도 확인되지 않는다 — 이 스크립트가 그 구멍을 메운다.
 *
 * Electron 이 필요하지만 창은 띄우지 않는다:
 *   npm run remote:keystore-probe
 *
 * 앱 재시작을 흉내내려고 인스턴스를 두 번 만든다(두 번째는 디스크에서만 읽는다).
 *
 * **최상위 await 를 쓰지 않는다.** Electron 은 main 엔트리 모듈의 평가가 끝난 뒤에 `ready` 를
 * 발생시키는데, ESM 최상위에서 `await app.whenReady()` 하면 서로를 기다리며 영원히 멈춘다.
 */

import { app, safeStorage } from 'electron'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

// src/main/** 은 확장자 없는 상대 import 를 쓴다(번들러 전제). 스크립트에서 그대로 돌리기 위한 훅.
register('./ts-resolve-hooks.mjs', pathToFileURL(join(import.meta.dirname, 'x')))

let failures = 0

function check(label, condition) {
  console.log(`  ${condition ? '✓' : '✗'} ${label}`)
  if (!condition) failures++
}

app.whenReady().then(async () => {
  try {
    await probe()
  } catch (err) {
    console.error('\n💥', err)
    failures++
  }
  console.log(failures === 0 ? '\n✅ 키스토어 실물 검증 통과' : `\n❌ 실패 ${failures}건`)
  app.exit(failures === 0 ? 0 : 1)
})

async function probe() {
  const { RemoteKeystore } = await import('../src/main/remote/keystore.ts')
  const { generateSessionKey, toBase64Url } = await import('../src/shared/crypto.ts')

  console.log('\n▸ OS 암호화 저장소')
  const available = safeStorage.isEncryptionAvailable()
  check('safeStorage 를 쓸 수 있다', available)
  if (!available) throw new Error('Keychain 을 쓸 수 없어 나머지를 검증할 수 없습니다.')

  const dir = mkdtempSync(join(tmpdir(), 'wooi-keystore-probe-'))
  const file = join(dir, 'remote.json')

  console.log('\n▸ 쓰기')
  // 첫 encryptString 은 macOS Keychain 항목을 만든다. 서명되지 않은 dev Electron 바이너리는
  // 여기서 승인 대화상자를 띄우고 **클릭할 때까지 블로킹된다** — 다른 창 뒤에 숨어 있으면
  // 그냥 멈춘 것처럼 보이므로 미리 알린다. (배포된 서명 앱은 자기 ACL 을 가져 조용히 통과한다.)
  console.log(
    '  · Keychain 승인 대화상자가 뜨면 허용을 눌러 주세요 (다른 창 뒤에 있을 수 있습니다).'
  )
  const first = new RemoteKeystore(dir)
  const identity = first.identity()
  const sessionKey = toBase64Url(generateSessionKey())
  first.setAuthSession('refresh-token-should-not-be-readable')
  first.addDevice({
    deviceId: '22222222-2222-2222-2222-222222222222',
    name: 'Probe iPhone',
    platform: 'ios',
    sessionKey,
    createdAt: Date.now()
  })
  check('machineId 가 만들어졌다', /^[0-9a-f-]{36}$/.test(identity.machineId))

  console.log('\n▸ 디스크에는 평문이 없다')
  const onDisk = readFileSync(file, 'utf-8')
  check('세션키가 파일에 없다', !onDisk.includes(sessionKey))
  check('refresh token 이 파일에 없다', !onDisk.includes('refresh-token-should-not-be-readable'))
  check('기기 이름이 파일에 없다', !onDisk.includes('Probe iPhone'))
  check('machineId 가 파일에 없다', !onDisk.includes(identity.machineId))

  console.log('\n▸ 앱 재시작 (새 인스턴스가 디스크에서만 읽는다)')
  const second = new RemoteKeystore(dir)
  check('machineId 가 유지된다', second.identity().machineId === identity.machineId)
  check(
    'refresh token 이 왕복한다',
    second.getAuthSession() === 'refresh-token-should-not-be-readable'
  )
  const device = second.getDevice('22222222-2222-2222-2222-222222222222')
  check('기기가 유지된다', device?.name === 'Probe iPhone')
  check('세션키가 바이트 단위로 같다', device?.sessionKey === sessionKey)

  console.log('\n▸ 변조된 파일은 조용히 넘어가지 않는다')
  // 봉투 안 암호문의 마지막 바이트를 뒤집으면 AEAD 검증이 실패해야 한다.
  const flipped = Buffer.from(JSON.parse(onDisk).payload, 'base64')
  flipped[flipped.length - 1] ^= 0xff
  writeFileSync(file, JSON.stringify({ version: 1, payload: flipped.toString('base64') }))
  let threw = false
  try {
    new RemoteKeystore(dir).read()
  } catch {
    threw = true
  }
  check('변조를 감지해 예외를 던진다', threw)

  rmSync(dir, { recursive: true, force: true })
}
