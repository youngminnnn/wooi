import type { UnpairOutcome } from './unpair'

export function unpairedNotice(outcome: UnpairOutcome): string | null {
  if (outcome === 'revoked') return null
  return 'Your laptop may still list this phone. Remove it in Settings → Integrations → Remote access.'
}
