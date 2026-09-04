import { useEffect, useRef, useState } from 'react'
import type { CarryItem, CarryMode, RunScript, SavedPrompt } from '@shared/types'
import { validateCarryPath } from '@shared/carryPath'
import { useStore } from '../store'
import Modal, { inputClass, labelClass, primaryBtn, ghostBtn } from './Modal'

// Carry 경로 행 전용 클래스.
// inputClass/ghostBtn 에 w-[…]·px-[…] 를 덧붙여 덮어쓰려 하면 안 된다 — Tailwind 는 충돌하는
// 유틸리티를 "클래스 문자열 순서"가 아니라 "생성된 CSS 순서"로 해결한다. 실제로 inputClass 의
// w-full 이 w-[5.5rem] 을 이겨서 select 가 행 전체(486px)를 차지하고, shrink-0 때문에 줄지도
// 않아 경로 입력창이 26px 로 찌그러졌다(ghostBtn 의 px-3.5 도 px-2 를 이겼다).
// 그래서 여기서는 공용 상수를 조합하지 않고 필요한 유틸리티만 직접 쓴다.
const carryFieldBase =
  'bg-[var(--bg-2)] border border-[var(--border)] rounded-lg text-neutral-100 focus:outline-none focus:border-[var(--border-strong)] transition-colors'
// 경로가 주인공이므로 남는 공간을 전부 가져간다(min-w-0 없으면 긴 경로가 행을 밀어낸다).
const carryPathClass =
  carryFieldBase + ' flex-1 min-w-0 px-3 py-2 font-mono text-base placeholder:text-neutral-600'
// mode 와 삭제 버튼은 내용에 딱 맞게 좁게. self-stretch 로 높이는 입력창과 맞춘다.
const carryModeClass = carryFieldBase + ' shrink-0 self-stretch w-16 px-1.5 text-xs'
const carryRemoveClass =
  'shrink-0 grid h-9 w-9 place-items-center rounded-lg border border-[var(--border-2)] text-xs text-neutral-400 hover:bg-[var(--surface-2)] hover:text-neutral-100 disabled:cursor-not-allowed disabled:opacity-30'

const sectionClass = 'rounded-xl border border-[var(--border)] bg-[var(--bg-2)]/25 p-4'
const sectionTitleClass = 'text-sm font-semibold text-neutral-100'
const sectionDescriptionClass = 'mt-1 text-xs leading-relaxed text-neutral-500'

function normalizeRunName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

export default function RepoConfigModal({
  repoId,
  onClose
}: {
  repoId: string
  onClose: () => void
}): React.JSX.Element | null {
  const app = useStore((s) => s.app)!
  const repo = app.repos.find((r) => r.id === repoId)
  // 리포가 제거되면(예: 아래 removeRepo) main 의 state 브로드캐스트가 onClose 보다 먼저 도착해
  // 이 모달이 사라진 리포로 한 번 더 렌더된다. 비널 단언으로 repo.name 등에 접근하면 렌더 중
  // TypeError 가 나고, 에러 바운더리가 없어 앱 전체가 멈춘다(먹통). repo 가 없으면 닫고 빠진다.
  const [name, setName] = useState(repo?.name ?? '')
  const [setupScript, setSetup] = useState(repo?.setupScript ?? '')
  const [runScripts, setRunScripts] = useState<RunScript[]>(repo?.runScripts ?? [])
  const [archiveScript, setArchive] = useState(repo?.archiveScript ?? '')
  const [carryItems, setCarryItems] = useState<CarryItem[]>(repo?.carryItems ?? [])
  const [savedPrompts, setSavedPrompts] = useState<SavedPrompt[]>(repo?.savedPrompts ?? [])

  const confirm = useStore((s) => s.confirm)
  const pushToast = useStore((s) => s.pushToast)

  // 행별 오류 메시지(없으면 null). 아직 비어 있는 행은 저장 시 버려지므로 오류로 보지 않는다 —
  // '+ Add path' 로 방금 만든 빈 행이 즉시 빨개지면 타이핑을 시작하기도 전에 혼내는 꼴이 된다.
  const carryErrors = carryItems.map((item) => {
    if (!item.path.trim()) return null
    const checked = validateCarryPath(item.path)
    return checked.ok ? null : checked.reason
  })
  const hasCarryError = carryErrors.some(Boolean)
  // 형태가 맞는 경로라도 리포 루트에 원본이 없으면 전달은 **영원히** 일어나지 않는다. 오류는
  // 아니라서 저장은 막지 않지만(파일을 나중에 만들 수도 있다) 그 사실은 지금 보여 줘야 한다 —
  // 이걸 알리지 않아, .env.local 을 워크트리 안에서만 만들어 온 사용자가 "등록해 뒀는데 아무것도
  // 안 온다"를 겪었다. 존재 확인은 파일시스템을 볼 수 있는 main 만 할 수 있어 IPC 로 물어본다.
  const [missingPaths, setMissingPaths] = useState<string[]>([])
  const carryWarnings = carryItems.map((item, i) => {
    const path = item.path.trim()
    // 형태 오류가 이미 떠 있는 행에 경고를 겹쳐 놓지 않는다 — 고칠 것은 하나다.
    if (!path || carryErrors[i] || !missingPaths.includes(path)) return null
    return 'Not in the repo root, so nothing is carried. Create it in the main checkout.'
  })
  const runNames = runScripts.map((script) => normalizeRunName(script.name))
  const runErrors = runScripts.map((script, index) => {
    if (!runNames[index]) return 'Enter a name.'
    if (runNames[index] === 'SETUP') return '“Setup” is reserved.'
    if (runNames.indexOf(runNames[index]) !== index) return 'Use a unique name.'
    if (!script.command.trim()) return 'Enter a command.'
    return null
  })
  const hasRunError = runErrors.some(Boolean)
  // 이름·본문이 **둘 다** 빈 행은 저장할 때 버리므로 오류로 보지 않는다 — '+ Add prompt' 로 방금
  // 만든 행이 타이핑을 시작하기도 전에 빨개지면 혼내는 꼴이 된다. 반쪽만 채운 행만 짚는다.
  const promptNames = savedPrompts.map((item) => item.name.trim().toLowerCase())
  const promptErrors = savedPrompts.map((item, index) => {
    const name = item.name.trim()
    const body = item.prompt.trim()
    if (!name && !body) return null
    if (!name) return 'Enter a name.'
    if (!body) return 'Enter the prompt.'
    if (promptNames.indexOf(promptNames[index]) !== index) return 'Use a unique name.'
    return null
  })
  const hasPromptError = promptErrors.some(Boolean)
  const errorCount =
    runErrors.filter(Boolean).length +
    carryErrors.filter(Boolean).length +
    promptErrors.filter(Boolean).length
  const isDirty = repo
    ? name !== repo.name ||
      setupScript !== repo.setupScript ||
      archiveScript !== repo.archiveScript ||
      JSON.stringify(runScripts) !== JSON.stringify(repo.runScripts) ||
      JSON.stringify(carryItems) !== JSON.stringify(repo.carryItems) ||
      JSON.stringify(savedPrompts) !== JSON.stringify(repo.savedPrompts ?? [])
    : false

  useEffect(() => {
    if (!repo) onClose()
  }, [repo, onClose])

  // 입력할 때마다 왕복하지 않도록 조금 늦춰서 묻는다. 경로 목록이 바뀔 때만 다시 확인하면
  // 되므로 문자열 하나로 접어 의존성으로 쓴다(배열을 그대로 쓰면 매 렌더 새 참조가 된다).
  const carryPathsKey = carryItems
    .map((i) => i.path.trim())
    .filter(Boolean)
    .join('\n')
  useEffect(() => {
    const paths = carryPathsKey.split('\n').filter(Boolean)
    let cancelled = false
    const timer = setTimeout(() => {
      if (paths.length === 0) {
        setMissingPaths([])
        return
      }
      void window.api.repo.missingCarryPaths(repoId, paths).then((missing) => {
        if (!cancelled) setMissingPaths(missing)
      })
    }, 300)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [repoId, carryPathsKey])

  // '+ Add path' 로 만든 빈 행에 포커스를 옮기기 위한 것들. 버튼에 포커스가 남으면 이어서 친
  // 글자가 아무 입력창에도 들어가지 않아 "입력이 안 된다"로 보인다(행은 늘었는데 타이핑만 무반응).
  const pathInputs = useRef<(HTMLInputElement | null)[]>([])
  const focusOnMount = useRef<number | null>(null)

  // 모든 훅 호출 뒤에서 가드한다(훅 규칙). repo 가 사라진 프레임에서는 아무것도 렌더하지 않고,
  // 위 useEffect 가 onClose 로 모달을 정리한다.
  if (!repo) return null

  const save = async (): Promise<void> => {
    // 저장 전에 막는다. 예전에는 잘못된 경로(절대 경로·`..`·`.git`)도 여기서 조용히 저장되고,
    // main 이 검증하는 시점이 워크스페이스 생성 때라서 한참 뒤에야 실패 토스트로 드러났다.
    if (carryErrors.some(Boolean)) return
    const res = await window.api.repo.update(repoId, {
      name: name.trim() || repo.name,
      setupScript,
      runScripts,
      archiveScript,
      // 빈 줄은 저장하지 않는다 — 편집 중 잠깐 비워 둔 행이 그대로 남지 않도록.
      carryItems: carryItems
        .filter((i) => i.path.trim())
        .map((i) => ({ ...i, path: i.path.trim() })),
      // 같은 이유로 빈 프롬프트 행도 버린다. main 이 다시 거르지만 여기서 먼저 정리해야
      // 저장 뒤 다시 열었을 때 화면이 방금 본 것과 같다.
      savedPrompts: savedPrompts
        .map((p) => ({ ...p, name: p.name.trim(), prompt: p.prompt.trim() }))
        .filter((p) => p.name && p.prompt)
    })
    // main 은 신뢰 경계라 같은 규칙으로 다시 검증한다. 여기까지 왔다면 렌더러 검증과 어긋난
    // 경우뿐이므로, 모달을 닫지 않고 이유를 그대로 보여 준다.
    if (res?.error) {
      pushToast('error', res.error)
      return
    }
    onClose()
  }

  const updateCarry = (index: number, patch: Partial<CarryItem>): void =>
    setCarryItems((items) => items.map((it, i) => (i === index ? { ...it, ...patch } : it)))

  const addCarryRow = (): void => {
    const lastIdx = carryItems.length - 1
    // 마지막 행이 아직 비어 있으면 빈 행을 또 만들지 않고 그 행으로 포커스만 옮긴다.
    if (lastIdx >= 0 && !carryItems[lastIdx].path.trim()) {
      pathInputs.current[lastIdx]?.focus()
      return
    }
    // 새 행의 input 은 아직 없으므로, 붙는 순간 ref 콜백에서 포커스한다.
    focusOnMount.current = carryItems.length
    setCarryItems((items) => [...items, { path: '', mode: 'copy' }])
  }

  const removeRepo = async (): Promise<void> => {
    const wsCount = app.workspaces.filter((w) => w.repoId === repoId).length
    const ok = await confirm({
      title: `Remove repository "${repo.name}"?`,
      body:
        wsCount > 0
          ? `${wsCount} workspace(s) and their worktree directories will also be removed. (Branches are kept.)`
          : undefined,
      confirmLabel: 'Remove repo',
      danger: true
    })
    if (!ok) return
    await window.api.repo.remove(repoId)
    onClose()
  }

  const requestClose = async (): Promise<void> => {
    if (!isDirty) {
      onClose()
      return
    }
    const ok = await confirm({
      title: 'Discard unsaved changes?',
      body: 'Your changes to this repository will be lost.',
      confirmLabel: 'Discard changes',
      danger: true
    })
    if (ok) onClose()
  }

  return (
    <Modal
      title={`Repository settings · ${repo.name}`}
      onClose={() => void requestClose()}
      width={720}
      footer={
        <>
          {isDirty && (
            <span className="mr-auto self-center text-xs text-neutral-500">Unsaved changes</span>
          )}
          {errorCount > 0 && (
            <span className="self-center text-xs text-[var(--danger-400)]">
              Fix {errorCount} {errorCount === 1 ? 'error' : 'errors'} to save
            </span>
          )}
          <button className={ghostBtn} onClick={() => void requestClose()}>
            Cancel
          </button>
          <button
            className={
              primaryBtn +
              (hasCarryError || hasRunError || hasPromptError
                ? ' opacity-40 cursor-not-allowed'
                : '')
            }
            onClick={save}
            disabled={hasCarryError || hasRunError || hasPromptError}
            title={
              hasCarryError || hasRunError || hasPromptError
                ? 'Fix the highlighted errors first'
                : undefined
            }
          >
            Save
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <section className={sectionClass} aria-labelledby="repo-general-heading">
          <h4 id="repo-general-heading" className={sectionTitleClass}>
            General
          </h4>
          <p className={sectionDescriptionClass}>Identify this repository throughout Wooi.</p>
          <div className="mt-4">
            <label className={labelClass} htmlFor="repo-display-name">
              Display name
            </label>
            <input
              id="repo-display-name"
              className={inputClass}
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <p className="mt-1.5 text-xs text-neutral-600 truncate" title={repo.path}>
              {repo.path}
            </p>
          </div>
        </section>

        <section className={sectionClass} aria-labelledby="repo-automation-heading">
          <h4 id="repo-automation-heading" className={sectionTitleClass}>
            Automation
          </h4>
          <p className={sectionDescriptionClass}>
            Commands that run during the workspace lifecycle.
          </p>
          <div className="mt-4">
            <label className={labelClass} htmlFor="repo-setup-script">
              Setup command
            </label>
            <input
              id="repo-setup-script"
              className={inputClass + ' font-mono'}
              value={setupScript}
              onChange={(e) => setSetup(e.target.value)}
              placeholder="e.g. npm install"
            />
            <p className="mt-1.5 text-xs text-neutral-600">
              Runs once right after a workspace is created (if set).
            </p>
          </div>

          <div className="mt-5">
            <div className="mb-2 flex items-end justify-between gap-4">
              <div>
                <p className={labelClass + ' mb-0'}>Run scripts</p>
                <p className="mt-1 text-xs text-neutral-600">
                  Start and stop these from the Scripts panel.
                </p>
              </div>
            </div>
            {runScripts.length > 0 && (
              <div className="mb-1.5 grid grid-cols-[7.5rem_minmax(0,1fr)_5.5rem_5rem] gap-2 px-1 text-xs font-medium uppercase tracking-wide text-neutral-600">
                <span>Name</span>
                <span>Command</span>
                <span>Auto-start</span>
                <span className="sr-only">Actions</span>
              </div>
            )}
            <div className="space-y-1.5">
              {runScripts.map((script, i) => (
                <div key={script.id}>
                  <div className="grid grid-cols-[7.5rem_minmax(0,1fr)_5.5rem_5rem] items-center gap-2">
                    <input
                      aria-label={`Script ${i + 1} name`}
                      aria-invalid={runErrors[i] ? true : undefined}
                      className={carryFieldBase + ' min-w-0 px-2.5 py-2 text-sm'}
                      value={script.name}
                      placeholder="Web"
                      onChange={(e) =>
                        setRunScripts((items) =>
                          items.map((x, n) => (n === i ? { ...x, name: e.target.value } : x))
                        )
                      }
                    />
                    <input
                      aria-label={`Script ${i + 1} command`}
                      aria-invalid={runErrors[i] ? true : undefined}
                      className={carryPathClass}
                      value={script.command}
                      placeholder="npm run dev"
                      onChange={(e) =>
                        setRunScripts((items) =>
                          items.map((x, n) => (n === i ? { ...x, command: e.target.value } : x))
                        )
                      }
                      onKeyDown={(e) => {
                        if (
                          e.key !== 'Enter' ||
                          e.nativeEvent.isComposing ||
                          !script.name.trim() ||
                          !script.command.trim()
                        )
                          return
                        e.preventDefault()
                        setRunScripts((items) => [
                          ...items,
                          { id: crypto.randomUUID(), name: '', command: '', autoStart: false }
                        ])
                      }}
                    />
                    <label className="flex items-center gap-1.5 text-xs text-neutral-400">
                      <input
                        type="checkbox"
                        checked={script.autoStart}
                        onChange={(e) =>
                          setRunScripts((items) =>
                            items.map((x, n) =>
                              n === i ? { ...x, autoStart: e.target.checked } : x
                            )
                          )
                        }
                      />{' '}
                      Auto
                    </label>
                    <div className="flex gap-1">
                      <button
                        className={carryRemoveClass}
                        disabled={i === 0}
                        onClick={() =>
                          setRunScripts((items) =>
                            i > 0
                              ? items.map((item, index) =>
                                  index === i - 1 ? items[i] : index === i ? items[i - 1] : item
                                )
                              : items
                          )
                        }
                        title="Move up"
                        aria-label={`Move ${script.name || `script ${i + 1}`} up`}
                      >
                        ↑
                      </button>
                      <button
                        className={carryRemoveClass}
                        onClick={() => setRunScripts((items) => items.filter((_, n) => n !== i))}
                        title="Remove"
                        aria-label={`Remove ${script.name || `script ${i + 1}`}`}
                      >
                        ✕
                      </button>
                    </div>
                  </div>
                  {runErrors[i] && (
                    <p className="mt-1 text-xs text-[var(--danger-400)]">{runErrors[i]}</p>
                  )}
                </div>
              ))}
            </div>
            {runScripts.length === 0 && (
              <div className="rounded-lg border border-dashed border-[var(--border-2)] px-4 py-3 text-sm text-neutral-500">
                No run scripts yet. Add one for a dev server, API, or worker.
              </div>
            )}
            <button
              className={ghostBtn + ' mt-1.5 text-xs'}
              onClick={() =>
                setRunScripts((items) => [
                  ...items,
                  { id: crypto.randomUUID(), name: '', command: '', autoStart: false }
                ])
              }
            >
              + Add run script
            </button>
            <p className="mt-2 text-xs text-neutral-600">
              Each workspace receives a unique <span className="font-mono">$PORT</span>. For
              example: <span className="font-mono text-neutral-500">vite --port $PORT</span>.
            </p>
          </div>

          <div className="mt-5">
            <div className="mb-2">
              <p className={labelClass + ' mb-0'}>Saved prompts</p>
              <p className="mt-1 text-xs text-neutral-600">
                Prompts you type often — a review request, a release-note draft, a test pass. Pick
                one from the composer or the fan-out dialog.
              </p>
            </div>
            {savedPrompts.length > 0 && (
              <div className="mb-1.5 grid grid-cols-[9rem_minmax(0,1fr)_2.5rem] gap-2 px-1 text-xs font-medium uppercase tracking-wide text-neutral-600">
                <span>Name</span>
                <span>Prompt</span>
                <span className="sr-only">Actions</span>
              </div>
            )}
            <div className="space-y-1.5">
              {savedPrompts.map((item, i) => (
                <div key={item.id}>
                  <div className="grid grid-cols-[9rem_minmax(0,1fr)_2.5rem] items-start gap-2">
                    <input
                      aria-label={`Prompt ${i + 1} name`}
                      aria-invalid={promptErrors[i] ? true : undefined}
                      className={carryFieldBase + ' min-w-0 px-2.5 py-2 text-sm'}
                      value={item.name}
                      placeholder="Review"
                      onChange={(e) =>
                        setSavedPrompts((items) =>
                          items.map((x, n) => (n === i ? { ...x, name: e.target.value } : x))
                        )
                      }
                    />
                    <textarea
                      aria-label={`Prompt ${i + 1} text`}
                      aria-invalid={promptErrors[i] ? true : undefined}
                      rows={2}
                      className={
                        carryFieldBase +
                        ' min-w-0 resize-y px-3 py-2 text-sm leading-relaxed placeholder:text-neutral-600'
                      }
                      value={item.prompt}
                      placeholder="Review the diff on this branch and list only real defects."
                      onChange={(e) =>
                        setSavedPrompts((items) =>
                          items.map((x, n) => (n === i ? { ...x, prompt: e.target.value } : x))
                        )
                      }
                    />
                    <button
                      className={carryRemoveClass}
                      onClick={() => setSavedPrompts((items) => items.filter((_, n) => n !== i))}
                      title="Remove"
                      aria-label={`Remove ${item.name || `prompt ${i + 1}`}`}
                    >
                      ✕
                    </button>
                  </div>
                  {promptErrors[i] && (
                    <p className="mt-1 text-xs text-[var(--danger-400)]">{promptErrors[i]}</p>
                  )}
                </div>
              ))}
            </div>
            {savedPrompts.length === 0 && (
              <div className="rounded-lg border border-dashed border-[var(--border-2)] px-4 py-3 text-sm text-neutral-500">
                No saved prompts yet. Add one you would otherwise retype every week.
              </div>
            )}
            <button
              className={ghostBtn + ' mt-1.5 text-xs'}
              onClick={() =>
                setSavedPrompts((items) => [
                  ...items,
                  { id: crypto.randomUUID(), name: '', prompt: '' }
                ])
              }
            >
              + Add prompt
            </button>
            <p className="mt-2 text-xs text-neutral-600">
              Picking one fills the message box so you can edit it — it never sends on its own.
            </p>
          </div>

          <div className="mt-5">
            <label className={labelClass} htmlFor="repo-archive-script">
              Archive command
            </label>
            <input
              id="repo-archive-script"
              className={inputClass + ' font-mono'}
              value={archiveScript}
              onChange={(e) => setArchive(e.target.value)}
              placeholder="e.g. docker compose down"
            />
            <p className="mt-1.5 text-xs text-neutral-600">
              Runs in the worktree when a workspace is archived (before the worktree is removed).
            </p>
          </div>
        </section>

        <section className={sectionClass} aria-labelledby="repo-files-heading">
          <h4 id="repo-files-heading" className={sectionTitleClass}>
            Workspace files
          </h4>
          <p className={sectionDescriptionClass}>
            New worktrees only contain git-tracked files, so ignored ones (
            <span className="font-mono">CLAUDE.local.md</span>,{' '}
            <span className="font-mono">.env</span>, …) are missing unless listed here. Paths are
            relative to the repo root — every workspace is filled from that main checkout, so a file
            that only exists inside a workspace is never carried.
          </p>

          <div className="mt-4 space-y-1.5">
            {carryItems.map((item, i) => (
              <div key={i}>
                <div className="flex items-center gap-1.5">
                  <input
                    ref={(el) => {
                      pathInputs.current[i] = el
                      if (el && focusOnMount.current === i) {
                        focusOnMount.current = null
                        el.focus()
                      }
                    }}
                    className={
                      carryPathClass +
                      (carryErrors[i]
                        ? ' border-[var(--danger-500)] focus:border-[var(--danger-400)]'
                        : '')
                    }
                    aria-invalid={carryErrors[i] ? true : undefined}
                    value={item.path}
                    onChange={(e) => updateCarry(i, { path: e.target.value })}
                    placeholder="e.g. CLAUDE.local.md"
                    spellCheck={false}
                    // Enter 로 다음 행을 이어서 추가한다(여러 경로를 손 안 떼고 입력).
                    onKeyDown={(e) => {
                      if (e.key !== 'Enter' || e.nativeEvent.isComposing) return
                      e.preventDefault()
                      if (!item.path.trim()) return
                      addCarryRow()
                    }}
                  />
                  <select
                    aria-label={`How to carry ${item.path || `file ${i + 1}`}`}
                    className={carryModeClass}
                    value={item.mode}
                    onChange={(e) => updateCarry(i, { mode: e.target.value as CarryMode })}
                  >
                    <option value="copy">Copy</option>
                    <option value="link">Link</option>
                  </select>
                  <button
                    className={carryRemoveClass}
                    onClick={() => setCarryItems((items) => items.filter((_, x) => x !== i))}
                    title="Remove"
                    aria-label={`Remove ${item.path || 'entry'}`}
                  >
                    ✕
                  </button>
                </div>
                {carryErrors[i] && (
                  <p className="mt-1 text-xs text-[var(--danger-400)]">{carryErrors[i]}</p>
                )}
                {carryWarnings[i] && (
                  <p className="mt-1 text-xs text-[var(--warning-400,#d9a441)]">
                    {carryWarnings[i]}
                  </p>
                )}
              </div>
            ))}
          </div>

          <button className={ghostBtn + ' mt-1.5 text-xs'} onClick={addCarryRow}>
            + Add path
          </button>

          <p className="mt-2 text-xs text-neutral-600">
            <span className="font-mono">Copy</span> gives each workspace its own independent copy —
            right for <span className="font-mono">.env</span>, where values like{' '}
            <span className="font-mono">$PORT</span> differ per workspace.{' '}
            <span className="font-mono">Link</span> symlinks the original, so edits are shared
            across every workspace.
          </p>
          {/* 동시 쓰기 레이스는 해결하지 않고 경고만 남긴다 — link 는 원본 하나를 N 개가 공유한다. */}
          {carryItems.some((i) => i.mode === 'link') && (
            <p className="mt-1.5 text-xs text-[var(--warning-400,#d9a441)]">
              Heads-up: linked files are shared. If parallel agents write to the same one (e.g. an
              accumulating <span className="font-mono">MEMORY.md</span>), they can overwrite each
              other. Use Copy if the agent is expected to write to it.
            </p>
          )}
        </section>

        <section
          className="rounded-xl border border-[var(--danger-500)]/35 bg-[var(--danger-500)]/5 p-4"
          aria-labelledby="repo-danger-heading"
        >
          <h4 id="repo-danger-heading" className="text-sm font-semibold text-[var(--danger-400)]">
            Danger zone
          </h4>
          <div className="mt-2 flex items-center justify-between gap-6">
            <p className="text-xs leading-relaxed text-neutral-500">
              Remove this repository
              {app.workspaces.filter((w) => w.repoId === repoId).length > 0
                ? ` and its ${app.workspaces.filter((w) => w.repoId === repoId).length} workspace(s)`
                : ''}
              . Worktree directories are deleted, but branches are kept.
            </p>
            <button
              className={
                ghostBtn +
                ' shrink-0 border-[var(--danger-500)]/50 text-[var(--danger-400)] hover:bg-[var(--danger-500)]/15'
              }
              onClick={removeRepo}
            >
              Remove repository…
            </button>
          </div>
        </section>
      </div>
    </Modal>
  )
}
