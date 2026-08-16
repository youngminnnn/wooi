import { useCallback, useEffect, useState } from 'react'
import { Loader2, Smartphone, Trash2 } from 'lucide-react'
import QRCode from 'qrcode'
import { useNow } from '../lib/useNow'
import { ghostBtn, primaryBtn } from './Modal'
import type { RemoteDeviceSummary, RemoteStatus } from '@shared/remote'
import type { AppSettings } from '@shared/types'

/**
 * 원격 접근(모바일 컴패니언) 설정 패널.
 *
 * 이 화면의 핵심은 QR 이 아니라 **SAS 확인 단계**다. 6자리가 폰과 일치하는지 사람이 보고
 * 승인해야만 세션키가 만들어진다 — QR 을 촬영한 공격자가 먼저 claim 하면 여기 뜨는 숫자와
 * 기기 이름이 달라지므로 사용자가 거부한다. 그래서 확인 단계는 눈에 띄고, 거부가 승인만큼 쉽다.
 */
interface RemoteAccessPanelProps {
  settings: AppSettings
  save: (patch: Partial<AppSettings>) => void
}

export default function RemoteAccessPanel({
  settings,
  save
}: RemoteAccessPanelProps): React.JSX.Element {
  const [status, setStatus] = useState<RemoteStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [confirmClear, setConfirmClear] = useState(false)

  useEffect(() => {
    void window.api.remote.getStatus().then(setStatus)
    return window.api.onRemote(setStatus)
  }, [])

  /** 모든 원격 동작은 상태를 돌려주므로, 응답을 그대로 반영하고 중복 클릭만 막는다. */
  const run = useCallback(async (action: () => Promise<RemoteStatus>) => {
    setBusy(true)
    try {
      setStatus(await action())
    } finally {
      setBusy(false)
    }
  }, [])

  if (!status) {
    return <p className="text-xs text-neutral-600">Loading…</p>
  }

  if (!status.configured) {
    return (
      <p className="text-xs text-neutral-600 leading-relaxed">
        Remote access is not configured in this build. It needs a relay project to connect through.
      </p>
    )
  }

  if (!status.storageAvailable) {
    return (
      <p className="text-xs text-[var(--danger-400)] leading-relaxed">
        Your system keychain is unavailable, so pairing keys cannot be stored securely. Remote
        access stays off rather than keeping keys in plain text.
      </p>
    )
  }

  const { pairing, connection } = status
  const pairingActive = pairing.phase !== 'idle' && pairing.phase !== 'done'

  return (
    <div className="space-y-3">
      <label className="flex items-start gap-2.5 cursor-pointer">
        <input
          type="checkbox"
          checked={status.enabled}
          disabled={busy}
          onChange={(e) => void run(() => window.api.remote.setEnabled(e.target.checked))}
          className="accent-blue-600 h-3.5 w-3.5 mt-0.5"
        />
        <span className="text-sm text-neutral-300">
          Allow remote access from a phone
          <span className="block text-xs text-neutral-600 leading-relaxed">
            Lets a paired phone watch your sessions, answer permission prompts, and send follow-up
            messages. Everything is end-to-end encrypted — the relay only ever sees ciphertext. Off
            by default; while it is off nothing is sent anywhere.
          </span>
        </span>
      </label>

      {status.fault && <Notice tone="danger">{status.fault}</Notice>}

      {status.enabled && (
        <>
          <ConnectionRow status={status} />

          {pairing.phase === 'confirming' && (
            <ConfirmPairing
              sas={pairing.sas ?? '······'}
              deviceName={pairing.deviceName ?? 'Unknown device'}
              busy={busy}
              onConfirm={() => void run(() => window.api.remote.pairConfirm())}
              onReject={() => void run(async () => window.api.remote.pairCancel())}
            />
          )}

          {pairing.phase === 'waiting' && (
            <WaitingForScan
              qr={pairing.qr}
              expiresAt={pairing.expiresAt}
              onCancel={() => void run(async () => window.api.remote.pairCancel())}
            />
          )}

          {pairing.phase === 'completing' && (
            <Notice tone="muted">
              <Loader2 size={13} className="inline animate-spin mr-1.5 -mt-0.5" />
              Handing the key to your phone…
            </Notice>
          )}

          {pairing.phase === 'error' && pairing.error && (
            <Notice tone="danger">{pairing.error}</Notice>
          )}

          {!pairingActive && (
            <button
              type="button"
              className={ghostBtn}
              disabled={busy || connection.status !== 'online'}
              onClick={() => void run(() => window.api.remote.pairStart())}
            >
              {pairing.phase === 'done' ? 'Pair another phone' : 'Pair a phone'}
            </button>
          )}

          {/* 푸시는 원격 접근과 별개의 결정이다 — 폰이 랩탑을 **볼 수 있는 것**과
              랩탑이 폰을 **깨우는 것**은 다른 거래이므로 스위치도 따로 둔다. */}
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.remotePushEnabled}
              disabled={busy}
              onChange={(e) => save({ remotePushEnabled: e.target.checked })}
              className="accent-blue-600 h-3.5 w-3.5 mt-0.5"
            />
            <span className="text-sm text-neutral-300">
              Send notifications to paired phones
              <span className="block text-xs text-neutral-600 leading-relaxed">
                Only when you are away from this laptop. The banner never names a workspace — it
                says something needs you, and the details are decrypted on your phone when you tap
                it.
              </span>
            </span>
          </label>

          <DeviceList
            devices={status.devices}
            busy={busy}
            onRevoke={(id) => void run(() => window.api.remote.revokeDevice(id))}
          />

          {status.devices.length > 0 && (
            <div className="pt-1">
              {confirmClear ? (
                <div className="flex items-center gap-2">
                  <span className="text-xs text-neutral-500 flex-1">
                    Every paired phone will need to pair again.
                  </span>
                  <button className={ghostBtn} onClick={() => setConfirmClear(false)}>
                    Keep
                  </button>
                  <button
                    className={primaryBtn}
                    disabled={busy}
                    onClick={() => {
                      setConfirmClear(false)
                      void run(() => window.api.remote.clearData())
                    }}
                  >
                    Delete
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="text-xs text-neutral-600 hover:text-[var(--danger-400)] transition-colors"
                  onClick={() => setConfirmClear(true)}
                >
                  Delete all remote data
                </button>
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}

// ── 연결 상태 ─────────────────────────────────────────────────────────────

const DOT: Record<string, string> = {
  online: 'bg-[var(--success-500)]',
  connecting: 'bg-[var(--warning-500)] animate-pulse',
  offline: 'bg-neutral-600',
  unavailable: 'bg-[var(--danger-500)]'
}

function ConnectionRow({ status }: { status: RemoteStatus }): React.JSX.Element {
  const { connection } = status
  const label =
    connection.status === 'online'
      ? 'Connected to the relay'
      : connection.status === 'connecting'
        ? 'Connecting…'
        : connection.status === 'unavailable'
          ? 'Unavailable'
          : 'Not connected'

  return (
    <div className="space-y-1">
      <div className="flex items-center gap-2 text-xs text-neutral-400">
        <span className={`h-1.5 w-1.5 rounded-full shrink-0 ${DOT[connection.status]}`} />
        {label}
      </div>
      {/* CAPTCHA 는 재시도로 풀리지 않는다 — 사용자가 개입해야 한다는 것을 분명히 말한다. */}
      {connection.needsCaptcha && (
        <Notice tone="danger">
          The relay is asking for a human check that this app cannot complete yet. Remote access
          stays off until this is resolved.
        </Notice>
      )}
      {!connection.needsCaptcha && connection.lastError && (
        <p className="text-xs text-neutral-600">{connection.lastError}</p>
      )}
    </div>
  )
}

// ── 페어링: QR 대기 ───────────────────────────────────────────────────────

function WaitingForScan({
  qr,
  expiresAt,
  onCancel
}: {
  qr: string | null
  expiresAt: number | null
  onCancel: () => void
}): React.JSX.Element {
  const [image, setImage] = useState<string | null>(null)
  const now = useNow(1000)

  useEffect(() => {
    if (!qr) return
    let alive = true
    // data URL 이라 CSP 의 `img-src 'self' data:` 를 그대로 통과한다 — 변경이 필요 없다.
    void QRCode.toDataURL(qr, { margin: 1, width: 220 }).then((url) => {
      if (alive) setImage(url)
    })
    return () => {
      alive = false
    }
  }, [qr])

  const secondsLeft = expiresAt ? Math.max(0, Math.round((expiresAt - now) / 1000)) : 0

  return (
    <div className="rounded-lg border border-[var(--border)] p-3 space-y-2.5">
      <div className="flex items-start gap-3">
        <div className="h-[110px] w-[110px] shrink-0 rounded bg-white p-1.5">
          {image && <img src={image} alt="Pairing QR code" className="h-full w-full" />}
        </div>
        <div className="min-w-0 flex-1 space-y-1.5">
          <p className="text-sm text-neutral-300">Scan this with the Wooi app on your phone.</p>
          <p className="text-xs text-neutral-600 leading-relaxed">
            The code expires in {formatSeconds(secondsLeft)}. It carries no keys — a photo of this
            screen is useless once your phone uses it.
          </p>
          <button type="button" className={ghostBtn} onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}

// ── 페어링: SAS 확인 ──────────────────────────────────────────────────────

function ConfirmPairing({
  sas,
  deviceName,
  busy,
  onConfirm,
  onReject
}: {
  sas: string
  deviceName: string
  busy: boolean
  onConfirm: () => void
  onReject: () => void
}): React.JSX.Element {
  return (
    <div className="rounded-lg border border-[var(--info-500)] bg-[var(--info-500)]/5 p-3 space-y-2.5">
      <p className="text-sm text-neutral-200">
        <span className="font-medium">{deviceName}</span> wants to pair.
      </p>
      <div className="text-center py-1">
        <div className="font-mono text-2xl tracking-[0.35em] text-neutral-100">{sas}</div>
        <p className="text-xs text-neutral-500 mt-1">
          Only continue if your phone shows exactly these six digits.
        </p>
      </div>
      {/* 거부가 승인만큼 쉬워야 한다 — 숫자가 다르면 그게 정확히 공격 신호다. */}
      <div className="flex gap-2">
        <button type="button" className={`${ghostBtn} flex-1`} disabled={busy} onClick={onReject}>
          They don&rsquo;t match
        </button>
        <button
          type="button"
          className={`${primaryBtn} flex-1`}
          disabled={busy}
          onClick={onConfirm}
        >
          They match — pair
        </button>
      </div>
    </div>
  )
}

// ── 기기 목록 ─────────────────────────────────────────────────────────────

function DeviceList({
  devices,
  busy,
  onRevoke
}: {
  devices: RemoteDeviceSummary[]
  busy: boolean
  onRevoke: (deviceId: string) => void
}): React.JSX.Element {
  if (devices.length === 0) {
    return <p className="text-xs text-neutral-600">No phones paired yet.</p>
  }
  return (
    <div className="space-y-1">
      {devices.map((device) => (
        <div
          key={device.deviceId}
          className="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-[var(--border)]"
        >
          <Smartphone size={14} className="shrink-0 text-neutral-500" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm text-neutral-300 truncate">{device.name}</span>
            <span className="block text-xs text-neutral-600">
              {device.platform === 'ios' ? 'iPhone' : 'Android'} · paired{' '}
              {new Date(device.createdAt).toLocaleDateString()}
            </span>
          </span>
          <button
            type="button"
            title="Revoke access"
            disabled={busy}
            onClick={() => onRevoke(device.deviceId)}
            className="shrink-0 p-1 rounded text-neutral-600 hover:text-[var(--danger-400)] transition-colors"
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
    </div>
  )
}

// ── 작은 것들 ─────────────────────────────────────────────────────────────

function Notice({
  tone,
  children
}: {
  tone: 'danger' | 'muted'
  children: React.ReactNode
}): React.JSX.Element {
  const color =
    tone === 'danger'
      ? 'border-[var(--danger-500)] text-[var(--danger-400)]'
      : 'border-[var(--border)] text-neutral-500'
  return (
    <div className={`rounded-lg border px-3 py-2 text-xs leading-relaxed ${color}`}>{children}</div>
  )
}

function formatSeconds(total: number): string {
  if (total <= 0) return 'a moment'
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return minutes > 0 ? `${minutes}m ${String(seconds).padStart(2, '0')}s` : `${seconds}s`
}
