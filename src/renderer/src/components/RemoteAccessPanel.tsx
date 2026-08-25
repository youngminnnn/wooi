import { useCallback, useEffect, useState } from 'react'
import { Loader2, Smartphone, Trash2 } from 'lucide-react'
import QRCode from 'qrcode'
import { useNow } from '../lib/useNow'
import { ghostBtn, primaryBtn } from './Modal'
import type { RemoteDeviceSummary, RemoteStatus } from '@shared/remote'
import { CURRENT_REMOTE_CONSENT_VERSION, type AppSettings } from '@shared/types'
import { WOOI_URLS } from '../lib/externalLinks'

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
  const [askingConsent, setAskingConsent] = useState(false)

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

  // 아직 열리지 않은 기능이다. "설정되지 않음" 같은 안내조차 띄우지 않는다 — 쓸 수 없는
  // 항목이 설정 화면에 남아 있으면 그 자체가 잘못된 약속이 된다.
  if (!status.available) return <></>

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
  /**
   * 페어링이 **지금 진행 중**인가. 여기서 'error' 를 빼는 것이 중요하다 — 코드는 5분이면
   * 만료되고 그때 phase 가 'error' 가 되는데, 이걸 진행 중으로 치면 다시 시작할 버튼이
   * 사라져 사용자가 원격 접근 자체를 껐다 켜야 한다(실제로 그렇게 막혔다).
   * 실패는 진행이 아니라 **끝난 상태**이고, 끝났으면 다시 시작할 수 있어야 한다.
   */
  const pairingActive =
    pairing.phase !== 'idle' && pairing.phase !== 'done' && pairing.phase !== 'error'
  const consented = settings.remoteConsentVersion === CURRENT_REMOTE_CONSENT_VERSION

  /**
   * 켜기는 동의를 지난다. 앱 전체 약관을 올리는 대신 여기서 묻는 이유는, 이 기능을 켜지 않을
   * 사람에게 재동의를 강요하지 않기 위해서다 — 그리고 결정이 실제로 일어나는 자리가 여기다.
   */
  const toggleEnabled = (next: boolean): void => {
    if (!next) {
      setAskingConsent(false)
      void run(() => window.api.remote.setEnabled(false))
      return
    }
    if (!consented) {
      setAskingConsent(true)
      return
    }
    void run(() => window.api.remote.setEnabled(true))
  }

  return (
    <div className="space-y-3">
      <label className="flex items-start gap-2.5 cursor-pointer">
        <input
          type="checkbox"
          checked={status.enabled}
          disabled={busy}
          onChange={(e) => toggleEnabled(e.target.checked)}
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

      {askingConsent && (
        <ConsentGate
          busy={busy}
          onCancel={() => setAskingConsent(false)}
          onAccept={() => {
            setAskingConsent(false)
            save({ remoteConsentVersion: CURRENT_REMOTE_CONSENT_VERSION })
            void run(() => window.api.remote.setEnabled(true))
          }}
        />
      )}

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
              {pairing.phase === 'error'
                ? 'Try again'
                : pairing.phase === 'done'
                  ? 'Pair another phone'
                  : 'Pair a phone'}
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
                The banner names the workspace and what happened — that name is the one thing sent
                in the clear. Everything else is decrypted on your phone when you tap it.
              </span>
            </span>
          </label>

          {/* 언제 보낼지는 켤지 말지와 다른 질문이다. 기본은 "자리를 비웠을 때만" 이라
              눈앞의 창이 이미 알려 준 일로 주머니가 울리지 않는다. */}
          {settings.remotePushEnabled && (
            <div className="pl-6 flex flex-col gap-1.5">
              <PushWhenOption
                checked={!settings.remotePushWhileActive}
                disabled={busy}
                onSelect={() => save({ remotePushWhileActive: false })}
                label="Only when I am away from this computer"
                hint="Silent while a Wooi window is in front of you and you are typing."
              />
              <PushWhenOption
                checked={settings.remotePushWhileActive}
                disabled={busy}
                onSelect={() => save({ remotePushWhileActive: true })}
                label="Always, even while I am using Wooi"
                hint="Your phone rings for every notification, desktop or not."
              />
            </div>
          )}

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

/**
 * 원격을 켜기 전에 데이터 흐름을 있는 그대로 보여 준다.
 *
 * 짧게 쓰는 것이 목적이다 — 길고 법률 같은 문장은 읽히지 않고 클릭만 훈련시킨다.
 * 여기서 말하는 것은 세 가지뿐이다: 무엇이 나가는가, 릴레이가 무엇을 볼 수 있는가,
 * 어떻게 되돌리는가.
 */
function ConsentGate({
  busy,
  onAccept,
  onCancel
}: {
  busy: boolean
  onAccept: () => void
  onCancel: () => void
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-[var(--border)] bg-[var(--bg-raised)] p-3 space-y-2">
      <p className="text-xs font-semibold text-neutral-300">Before you turn this on</p>
      <ul className="space-y-1 text-xs text-neutral-500 leading-relaxed list-disc pl-4">
        <li>
          Your computer and phone talk through a relay run by Wooi&apos;s maintainer. Your computer
          only makes outbound connections — nothing here becomes reachable from the internet.
        </li>
        <li>
          Messages, code, file paths, and workspace names are encrypted with a key the relay never
          sees. It carries ciphertext it cannot read.
        </li>
        <li>
          The relay does see metadata: random identifiers, timestamps, message sizes, and your
          phone&apos;s device name.
        </li>
        <li>
          You can revoke a phone or delete everything from this panel at any time. Turning this off
          stops all traffic.
        </li>
      </ul>
      <button
        type="button"
        className="text-xs text-neutral-500 hover:text-neutral-300 underline underline-offset-2 transition-colors"
        onClick={() => void window.api.openExternal(WOOI_URLS.privacyPolicy)}
      >
        Read the full privacy policy
      </button>
      <div className="flex items-center gap-2 pt-1">
        <button type="button" className={ghostBtn} onClick={onCancel}>
          Not now
        </button>
        <button type="button" className={primaryBtn} disabled={busy} onClick={onAccept}>
          Enable remote access
        </button>
      </div>
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
  const [copied, setCopied] = useState(false)
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
            screen is useless once your phone uses it. If the phone cannot scan, copy the code and
            paste it there.
          </p>
          <div className="flex items-center gap-2">
            <button type="button" className={ghostBtn} onClick={onCancel}>
              Cancel
            </button>
            {/* 카메라가 유일한 경로면 막히는 경우가 있다 — 권한을 거부했거나, 기기에 카메라가
                없거나, 이 화면을 카메라로 겨눌 수 없는 상황. 폰의 "Paste the code" 가 받는 것이
                바로 이 문자열이다. 보안 성질은 같다(1회용 코드 + 여섯 자리 확인). */}
            <button
              type="button"
              className={ghostBtn}
              disabled={!qr}
              onClick={() => {
                if (!qr) return
                void navigator.clipboard.writeText(qr).then(() => {
                  setCopied(true)
                  setTimeout(() => setCopied(false), 1800)
                })
              }}
            >
              {copied ? 'Copied' : 'Copy code'}
            </button>
          </div>
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

interface PushWhenOptionProps {
  checked: boolean
  disabled: boolean
  onSelect: () => void
  label: string
  hint: string
}

function PushWhenOption({
  checked,
  disabled,
  onSelect,
  label,
  hint
}: PushWhenOptionProps): React.JSX.Element {
  return (
    <label className="flex items-start gap-2.5 cursor-pointer">
      <input
        type="radio"
        name="remote-push-when"
        checked={checked}
        disabled={disabled}
        onChange={onSelect}
        className="accent-blue-600 h-3.5 w-3.5 mt-0.5"
      />
      <span className="text-sm text-neutral-300">
        {label}
        <span className="block text-xs text-neutral-600 leading-relaxed">{hint}</span>
      </span>
    </label>
  )
}
