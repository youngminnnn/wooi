import type { ReactElement } from 'react'
import { render } from '@testing-library/react'
import { useStore } from '../store'
import { fakeApi } from './fakeApi'

const INITIAL = useStore.getState()
let subscriptionsReady = false

export function resetStore(): void {
  useStore.setState(INITIAL, true)
}

export async function startStoreSubscriptions(): Promise<void> {
  if (subscriptionsReady) return
  await useStore.getState().init()
  subscriptionsReady = true
}

export function dispatch(channel: string, payload: unknown): void {
  fakeApi.dispatch(channel, payload)
}

export function renderWithStore(ui: ReactElement): ReturnType<typeof render> {
  return render(ui)
}

export { fakeApi, useStore }
