import { describe, expect, it } from 'vitest'
import { CLIENT_CAPABILITIES } from './appServer'

describe('Codex app-server capabilities', () => {
  it('advertises the extended form used by request_plugin_install', () => {
    expect(CLIENT_CAPABILITIES).toMatchObject({
      experimentalApi: true,
      mcpServerOpenaiFormElicitation: true
    })
  })
})
