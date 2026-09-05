/** `react-dom/client` 재노출. CJS 라 이름을 명시한다 — 이유는 [[react.js]] 와 같다. */
import client from 'react-dom/client'

export default client
export const { createRoot, hydrateRoot, version } = client
