// branch-name-rule.mjs 의 타입 선언. 규칙은 훅·CI 가 순수 Node 로 실행해야 하므로 .mjs 로
// 두고(그쪽에는 빌드 단계가 없다), 앱 코드가 같은 파일을 import 할 수 있도록 타입만 여기 적는다.
export declare const TYPES: string[]
export declare const PATTERN: RegExp
export declare function isAllowedBranchName(branch: string): boolean
