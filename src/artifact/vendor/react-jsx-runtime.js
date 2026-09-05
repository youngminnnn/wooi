/**
 * `react/jsx-runtime` 재노출 — 모델이 쓰지 않지만 **모든** React 아티팩트가 의존한다.
 *
 * sucrase 의 automatic 런타임이 JSX 를 이 지정자로 컴파일하기 때문이다. 그리고 이것도 CJS 라
 * `export *` 로는 이름이 안 나온다 — 이유는 [[react.js]] 와 같다.
 */
import runtime from 'react/jsx-runtime'

export default runtime
export const { Fragment, jsx, jsxs } = runtime
