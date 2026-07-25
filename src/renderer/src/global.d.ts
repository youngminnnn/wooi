import type { WooiApi } from '@shared/api'

declare global {
  interface Window {
    api: WooiApi
  }
}

export {}
