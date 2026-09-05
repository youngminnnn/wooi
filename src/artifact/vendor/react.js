/**
 * `react` 의 아티팩트용 재노출.
 *
 * `export * from 'react'` 로는 **안 된다.** react 는 CJS 이고 그 진입점이
 * `module.exports = require('./cjs/react.production.js')` 라, 롤업이 named export 를 정적으로
 * 못 읽는다 — 결과물에 `default` 하나만 남고 게스트는
 * "does not provide an export named 'createElement'" 로 죽는다(실측).
 *
 * 그래서 이름을 손으로 적는다. 목록이 낡으면 `artifactVendor.test.ts` 가 잡는다 —
 * 그 테스트가 `Object.keys(require('react'))` 와 이 파일을 대조한다.
 */
import React from 'react'

export default React
export const {
  Activity,
  Children,
  Component,
  Fragment,
  Profiler,
  PureComponent,
  StrictMode,
  Suspense,
  act,
  cache,
  cacheSignal,
  captureOwnerStack,
  cloneElement,
  createContext,
  createElement,
  createRef,
  forwardRef,
  isValidElement,
  lazy,
  memo,
  startTransition,
  unstable_useCacheRefresh,
  use,
  useActionState,
  useCallback,
  useContext,
  useDebugValue,
  useDeferredValue,
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useOptimistic,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  version
} = React
