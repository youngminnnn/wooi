import { describe, expect, it } from 'vitest'
import { CLIENT_CAPABILITIES } from './appServer'
import { normalizeMcpAuthStatus, NOTIFY, RPC } from './wire'

describe('Codex app-server capabilities', () => {
  it('advertises the extended form used by request_plugin_install', () => {
    expect(CLIENT_CAPABILITIES).toMatchObject({
      experimentalApi: true,
      mcpServerOpenaiFormElicitation: true
    })
  })
})

describe('Codex 0.147 MCP OAuth와 auto-review 메서드', () => {
  it('스키마의 정확한 wire 이름을 쓴다', () => {
    expect(RPC.mcpOauthLogin).toBe('mcpServer/oauth/login')
    expect(NOTIFY.mcpOauthLoginCompleted).toBe('mcpServer/oauthLogin/completed')
    expect(NOTIFY.guardianApprovalReviewStarted).toBe('item/autoApprovalReview/started')
    expect(NOTIFY.guardianApprovalReviewCompleted).toBe('item/autoApprovalReview/completed')
  })

  it('인증 필요와 unknown 을 서로 다른 상태로 보존한다', () => {
    expect(normalizeMcpAuthStatus('notLoggedIn')).toBe('notLoggedIn')
    expect(normalizeMcpAuthStatus('unknown')).toBe('unknown')
    expect(normalizeMcpAuthStatus('futureStatus')).toBe('unknown')
    expect(normalizeMcpAuthStatus(undefined)).toBe('unknown')
  })
})
