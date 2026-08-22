import { shell } from 'electron'
import { spawn } from 'node:child_process'
import { basename } from 'node:path'

const TERMINAL_EDITORS = new Set([
  'vi',
  'vim',
  'nvim',
  'nano',
  'pico',
  'ed',
  'emacs',
  'emacsclient',
  'helix',
  'hx',
  'kak',
  'micro',
  'joe',
  'mg'
])

/**
 * 경로를 사용자의 에디터로 연다. GUI 에서 터미널 전용 에디터를 띄우면 편집할 TTY 가 없으므로
 * 건너뛰고, 실행할 에디터가 없거나 실행이 실패하면 Finder 가 아니라 그 경로 자체를 OS 기본 앱에
 * 맡긴다.
 */
export function openInEditor(target: string): void {
  const configured = [process.env.VISUAL, process.env.EDITOR]
    .map((value) => value?.trim())
    .find((value) => {
      if (!value) return false
      const command = value.split(/\s+/, 1)[0]
      return !TERMINAL_EDITORS.has(basename(command))
    })
  const editorCmd = configured || 'code'
  const loginShell = process.env.SHELL || '/bin/zsh'
  // 대상 경로는 positional 인자($1)로 넘겨 셸 메타문자가 명령으로 해석되지 않게 한다.
  // 에디터 바이너리를 찾을 PATH 확보를 위해 로그인 셸은 유지한다.
  const proc = spawn(loginShell, ['-lc', `${editorCmd} "$1"`, loginShell, target])
  let fellBack = false
  const fallback = (): void => {
    if (fellBack) return
    fellBack = true
    void shell.openPath(target)
  }
  proc.on('error', fallback)
  proc.on('exit', (code) => {
    if (code !== 0) fallback()
  })
}
