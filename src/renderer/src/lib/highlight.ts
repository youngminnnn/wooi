import hljs from 'highlight.js'

/** 이보다 큰 파일은 하이라이트를 생략하고 평문으로 표시(렌더 지연 방지). */
export const HIGHLIGHT_MAX = 200_000

/** 언어를 못 정한 파일에 한해 자동 감지를 시도하는 상한. 자동 감지는 전 언어를 훑어 비싸다. */
const AUTO_MAX = 50_000

/** 확장자 → highlight.js 언어. 여기 없으면 hljs 가 아는 이름인지 한 번 더 물어본다. */
const BY_EXT: Record<string, string> = {
  ts: 'typescript',
  tsx: 'typescript',
  mts: 'typescript',
  cts: 'typescript',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  json: 'json',
  jsonc: 'json',
  css: 'css',
  scss: 'scss',
  sass: 'scss',
  less: 'less',
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  vue: 'xml',
  svelte: 'xml',
  md: 'markdown',
  mdx: 'markdown',
  markdown: 'markdown',
  yml: 'yaml',
  yaml: 'yaml',
  toml: 'ini',
  ini: 'ini',
  cfg: 'ini',
  conf: 'ini',
  sh: 'bash',
  bash: 'bash',
  zsh: 'bash',
  fish: 'bash',
  py: 'python',
  rb: 'ruby',
  go: 'go',
  rs: 'rust',
  java: 'java',
  kt: 'kotlin',
  kts: 'kotlin',
  swift: 'swift',
  m: 'objectivec',
  mm: 'objectivec',
  c: 'c',
  h: 'c',
  cc: 'cpp',
  cxx: 'cpp',
  cpp: 'cpp',
  hpp: 'cpp',
  cs: 'csharp',
  php: 'php',
  sql: 'sql',
  graphql: 'graphql',
  gql: 'graphql',
  dart: 'dart',
  lua: 'lua',
  pl: 'perl',
  pm: 'perl',
  r: 'r',
  scala: 'scala',
  ex: 'elixir',
  exs: 'elixir',
  erl: 'erlang',
  hs: 'haskell',
  clj: 'clojure',
  groovy: 'groovy',
  gradle: 'groovy',
  ps1: 'powershell',
  diff: 'diff',
  patch: 'diff',
  proto: 'protobuf',
  tf: 'hcl',
  hcl: 'hcl'
}

/** 확장자가 없거나 확장자만으로는 못 알아보는 관용 파일명(소문자 비교). */
const BY_NAME: Record<string, string> = {
  dockerfile: 'dockerfile',
  makefile: 'makefile',
  gemfile: 'ruby',
  rakefile: 'ruby',
  brewfile: 'ruby',
  'cmakelists.txt': 'cmake',
  '.env': 'ini',
  '.gitignore': 'plaintext',
  '.gitattributes': 'plaintext',
  '.npmrc': 'ini',
  '.editorconfig': 'ini'
}

/** 경로에서 highlight.js 언어를 유추한다. 못 정하면 null. */
export function languageOf(path: string): string | null {
  const name = path.split(/[\\/]/).pop()?.toLowerCase() ?? ''
  const byName = BY_NAME[name]
  if (byName) return byName

  const dot = name.lastIndexOf('.')
  // dot === 0 은 `.gitignore` 처럼 이름 전체가 확장자인 경우 — 위 표에서만 처리한다.
  if (dot <= 0) return null
  const ext = name.slice(dot + 1)
  return BY_EXT[ext] ?? (hljs.getLanguage(ext) ? ext : null)
}

/**
 * 파일 본문을 하이라이트한 HTML. 실패하거나 대상이 아니면 null(호출자가 평문으로 그린다).
 *
 * 확장자로 언어를 먼저 정하는 이유 — `highlightAuto` 는 등록된 모든 언어를 시도해 느리고,
 * 짧은 파일에서는 엉뚱한 언어로 색칠하는 일이 잦다. 큰 뷰어일수록 둘 다 체감된다.
 */
export function highlightFile(path: string, text: string): string | null {
  if (text.length > HIGHLIGHT_MAX) return null
  const language = languageOf(path)
  try {
    if (language) return hljs.highlight(text, { language, ignoreIllegals: true }).value
    if (text.length > AUTO_MAX) return null
    return hljs.highlightAuto(text).value
  } catch {
    return null
  }
}
