import { describe, expect, it } from 'vitest'
import type { PermissionMode } from '@shared/types'
import { asksForApproval, turnArgsFor } from './modes'

describe('Antigravity permission modes', () => {
  it.each([
    ['plan', ['--mode', 'plan']],
    ['default', ['--mode', 'accept-edits']],
    ['fullAccess', ['--dangerously-skip-permissions']]
  ] as const)('maps %s', (mode, args) => {
    expect(turnArgsFor(mode)).toEqual(args)
  })

  it.each(['acceptEdits', 'auto', 'readOnly', null] as const)(
    'falls back from %s to the default mode',
    (mode) => {
      expect(turnArgsFor(mode as PermissionMode | null)).toEqual(['--mode', 'accept-edits'])
    }
  )

  it.each(['plan', 'default', 'fullAccess', 'acceptEdits', 'auto', 'readOnly', null] as const)(
    'never asks for approval in %s',
    (mode) => {
      expect(asksForApproval(mode as PermissionMode | null)).toBe(false)
    }
  )
})
