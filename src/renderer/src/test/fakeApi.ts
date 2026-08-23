import type { WooiApi } from '@shared/api'

type Handler = (...args: never[]) => unknown

export interface ApiCall {
  path: string
  args: unknown[]
}

const EMPTY_APP = {
  repos: [],
  workspaces: [],
  fanoutGroups: [],
  reviews: [],
  settings: { defaultRightPanelOpen: true }
}

function defaultValue(path: string): unknown {
  const leaf = path.split('.').at(-1) ?? ''
  if (leaf.startsWith('on')) return () => {}
  if (path === 'getState') return EMPTY_APP
  if (path === 'auth.getStatus') {
    return {
      github: { installed: false, loggedIn: false },
      agents: {
        claude: { installed: false, loggedIn: false },
        codex: { installed: false, loggedIn: false }
      }
    }
  }
  if (/\.(list|search|getHistory|getCosts|getStatus|getOutput)$/.test(path)) return []
  if (/\.(status|statusForBranch|load|read|diff)$/.test(path)) return null
  if (leaf === 'getState') return {}
  return {}
}

export function createFakeApi(): {
  api: WooiApi
  calls: ApiCall[]
  override(path: string, handler: Handler): void
  called(path: string): ApiCall[]
  dispatch(channel: string, payload: unknown): void
  reset(): void
} {
  const calls: ApiCall[] = []
  const overrides = new Map<string, Handler>()
  const listeners = new Map<string, Set<Handler>>()
  const proxies = new Map<string, unknown>()

  const make = (prefix: string): unknown => {
    if (proxies.has(prefix)) return proxies.get(prefix)
    const proxy = new Proxy(() => {}, {
      get: (_target, key) => {
        if (key === 'then') return undefined
        const path = prefix ? `${prefix}.${String(key)}` : String(key)
        return make(path)
      },
      apply: (_target, _this, rawArgs) => {
        const args = [...rawArgs]
        calls.push({ path: prefix, args })
        const leaf = prefix.split('.').at(-1) ?? ''
        if (leaf.startsWith('on') && typeof args[0] === 'function') {
          const set = listeners.get(prefix) ?? new Set<Handler>()
          set.add(args[0] as Handler)
          listeners.set(prefix, set)
          return () => set.delete(args[0] as Handler)
        }
        const value = overrides.has(prefix)
          ? overrides.get(prefix)!(...(args as never[]))
          : defaultValue(prefix)
        return Promise.resolve(value)
      }
    })
    proxies.set(prefix, proxy)
    return proxy
  }

  return {
    api: make('') as WooiApi,
    calls,
    override: (path, handler) => overrides.set(path, handler),
    called: (path) => calls.filter((call) => call.path === path),
    dispatch: (channel, payload) => {
      for (const listener of listeners.get(channel) ?? []) listener(payload as never)
    },
    reset: () => {
      calls.length = 0
      overrides.clear()
    }
  }
}

export const fakeApi = createFakeApi()
