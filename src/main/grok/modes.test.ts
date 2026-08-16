import { describe, expect, it } from 'vitest'
import { grokModeFor, midSessionModeFor, permissionModeFromGrok } from './modes'

describe('Grok permission modes', () => {
  const rows = [
    ['plan', { modeId: 'plan' }],
    ['readOnly', { modeId: 'ask' }],
    ['default', { modeId: 'default' }],
    ['auto', { modeId: 'default', meta: { autoMode: true } }],
    ['fullAccess', { modeId: 'default', meta: { yoloMode: true } }]
  ] as const

  it.each(rows)('maps Wooi %s to Grok axes', (mode, expected) => {
    expect(grokModeFor(mode)).toEqual(expected)
  })

  it.each(rows)('maps Grok axes back to Wooi %s', (mode, selection) => {
    expect(
      permissionModeFromGrok(selection.modeId, 'meta' in selection ? selection.meta : undefined)
    ).toBe(mode)
  })

  it('lets yolo supersede auto', () => {
    expect(permissionModeFromGrok('default', { autoMode: true, yoloMode: true })).toBe('fullAccess')
  })

  it('switches the mode axis without reopening a session', () => {
    expect(midSessionModeFor('auto')).toEqual({ modeId: 'default', autoApprove: 'auto' })
    expect(midSessionModeFor('fullAccess')).toEqual({ modeId: 'default', autoApprove: 'yolo' })
    expect(midSessionModeFor('plan')).toEqual({ modeId: 'plan', autoApprove: 'none' })
  })
})
