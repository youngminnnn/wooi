import type { DittoApi } from '@shared/api'

declare global {
  interface Window {
    api: DittoApi
  }
}

export {}
