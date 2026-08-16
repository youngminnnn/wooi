/**
 * Wooi Remote — 발행된 상태 스냅샷을 열어 본다.
 *
 * 릴레이에는 암호문만 있으므로, "폰이 왜 이걸 못 보나" 를 조사하려면 **랩탑 키로 직접 열어**
 * 무엇을 발행했는지 봐야 한다. 원격 문제의 절반은 "안 보낸 것"과 "못 연 것"의 구분이고,
 * 그 구분을 눈으로 하려면 이 스크립트가 필요하다.
 *
 * 세션키는 safeStorage 로 봉인되어 있어 Electron 이 있어야 읽힌다. 창은 띄우지 않는다:
 *
 *   1) 릴레이에서 행을 가져와 /tmp/state_row.json 에 둔다 (nonce_hex, ct_hex, device_id)
 *   2) electron scripts/remote-state-probe.mjs
 *
 * 메시지 내용은 찍지 않는다 — 구조와 개수만 본다.
 */

import { app, safeStorage } from 'electron'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

register('./ts-resolve-hooks.mjs', pathToFileURL(join(import.meta.dirname, 'x')))

// safeStorage 의 키체인 항목은 **앱 이름**에 묶인다(`<name> Safe Storage`). 이 스크립트를
// `electron scripts/...` 로 띄우면 이름이 'Electron' 이 되어 dev 앱이 봉인한 파일을 열지 못한다.
// package.json 의 name 과 맞춰 준다.
app.setName('wooi')

const KEYSTORE = join(homedir(), 'Library/Application Support/Wooi (dev)/remote.json')
const ROW = '/tmp/state_row.json'

function fromHex(hex) {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  return bytes
}

app.whenReady().then(async () => {
  try {
    const { deriveDirectionKeys, fromBase64Url, openJson } = await import(
      pathToFileURL(join(import.meta.dirname, '../src/shared/crypto.ts')).href
    )

    const envelope = JSON.parse(readFileSync(KEYSTORE, 'utf-8'))
    const keystore = JSON.parse(safeStorage.decryptString(Buffer.from(envelope.payload, 'base64')))
    const row = JSON.parse(readFileSync(ROW, 'utf-8'))[0]

    const device = keystore.devices.find((d) => d.deviceId === row.device_id)
    if (!device) {
      console.log('이 기기의 세션키가 키스토어에 없습니다 — 랩탑이 이미 revoke 했거나 재페어링됨.')
      console.log(
        '키스토어의 기기:',
        keystore.devices.map((d) => d.deviceId)
      )
      app.exit(1)
      return
    }

    const { laptopToPhone } = deriveDirectionKeys(fromBase64Url(device.sessionKey), device.deviceId)
    const state = openJson(
      laptopToPhone,
      { v: 1, machineId: row.machine_id, deviceId: device.deviceId, kind: 'state' },
      { nonce: fromHex(row.nonce_hex), ct: fromHex(row.ct_hex) }
    )

    console.log(`rev                : ${state.rev} (행 ${row.rev})`)
    console.log(`workspaces         : ${state.workspaces.length}`)
    console.log(`pendingPermissions : ${state.pendingPermissions.length}`)
    for (const request of state.pendingPermissions) {
      console.log(
        `   - workspaceId=${request.workspaceId} tool=${request.toolName} ` +
          `kind=${request.kind ?? '(없음)'} input=${typeof request.input} ` +
          `keys=[${Object.keys(request).join(',')}]`
      )
    }
    const flagged = state.workspaces.filter((w) => w.attention !== null)
    console.log(`attention 있는 워크스페이스: ${flagged.length}`)
    for (const w of flagged) console.log(`   - ${w.id} → ${w.attention}`)
  } catch (err) {
    console.error('💥', err)
    app.exit(1)
    return
  }
  app.exit(0)
})
