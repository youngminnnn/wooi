#!/usr/bin/env node
/**
 * 릴레이(Supabase) 배포 도구.
 *
 *   node scripts/relay.mjs <development|production> <status|migrate|functions|config>
 *
 * 왜 스크립트인가 — Supabase CLI 의 명령마다 "어느 프로젝트인가"를 말하는 방법이 다르다:
 *
 *   supabase db push        --project-ref 없음 → --db-url 로만 겨냥할 수 있다
 *   supabase migration list --project-ref 없음 → 같음
 *   supabase functions deploy / config push     → --project-ref 를 받는다
 *
 * `--db-url` 을 빼면 CLI 는 **링크된 프로젝트로 조용히 떨어진다**. 그래서 운영을 겨냥한 줄
 * 알았던 명령이 개발 프로젝트를 보고 "다 적용됨"이라고 답하는 일이 실제로 일어났다.
 * (`SUPABASE_DB_URL` 환경변수도 무시된다 — 확인함. 반드시 플래그로 줘야 한다.)
 *
 * 그래서 여기서는 링크 상태를 절대 쓰지 않고, 매번 접속 문자열을 만들어 명시한다.
 */

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'

/**
 * 풀러 호스트는 프로젝트마다 다르다 — 같은 리전인데도 dev 는 aws-1, prod 는 aws-0 이다.
 * 앞의 번호는 리전이 아니라 **그 리전 안의 풀러(Supavisor) 클러스터**를 가리키고, 배정은
 * 프로비저닝 시점의 사정에 따른다(나중에 만든 prod 가 0번이다). Supabase 문서는 이 접두사를
 * 설명하지 않고 "대시보드에서 접속 문자열을 복사하라"고만 한다 — 손으로 조립하지 말라는 뜻이다.
 *
 * 그래서 실행할 때마다 Management API 에 물어본다. 아래 값은 마지막으로 확인된 값이고,
 * 조회가 실패했을 때(오프라인, 토큰 없음)의 대비책일 뿐이다.
 *
 * 풀러의 5432 는 **세션 모드**다 — 마이그레이션은 트랜잭션 모드(6543)에서 돌지 않는다.
 * 직접 접속(db.<ref>.supabase.co)은 무료 티어에서 IPv6 전용이라 이 머신에서 닿지 않는다.
 */
const ENVIRONMENTS = {
  development: {
    ref: 'vicgdpqmaazavjezxkxx',
    lastKnownPoolerHost: 'aws-1-ap-northeast-2.pooler.supabase.com',
    keychainService: 'wooi-supabase-development-db'
  },
  production: {
    ref: 'hdaumqthnvplmbbytwrf',
    lastKnownPoolerHost: 'aws-0-ap-northeast-2.pooler.supabase.com',
    keychainService: 'wooi-supabase-production-db'
  }
}

const ACTIONS = new Set(['status', 'migrate', 'functions', 'config'])

const [environmentName, action] = process.argv.slice(2)
const environment = ENVIRONMENTS[environmentName]
if (!environment || !ACTIONS.has(action)) {
  console.error(
    `사용법: node scripts/relay.mjs <${Object.keys(ENVIRONMENTS).join('|')}> <${[...ACTIONS].join('|')}>`
  )
  process.exit(2)
}

function databasePassword() {
  try {
    return execFileSync(
      'security',
      ['find-generic-password', '-a', 'wooi', '-s', environment.keychainService, '-w'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
    ).trim()
  } catch {
    console.error(
      `키체인에 ${environment.keychainService} 가 없습니다.\n\n` +
        `DB 비밀번호는 생성 시점에 한 번만 보여 주고 이후에는 다시 볼 수 없다 — 재설정만 가능하다:\n` +
        `  https://supabase.com/dashboard/project/${environment.ref}/settings/database\n\n` +
        `재설정한 값을 아래로 저장한다(입력은 화면에 남지 않는다):\n` +
        `  security add-generic-password -U -a wooi -s ${environment.keychainService} -w\n`
    )
    process.exit(1)
  }
}

/**
 * Supabase 관리 토큰. CLI 가 로그인하며 키체인에 넣어 둔 것을 쓴다 — 우리가 따로 받아 둘
 * 이유가 없다. CI 나 리눅스처럼 키체인이 없는 곳은 환경변수로 준다.
 */
function accessToken() {
  const fromEnvironment = process.env.SUPABASE_ACCESS_TOKEN?.trim()
  if (fromEnvironment) return fromEnvironment
  try {
    return execFileSync('security', ['find-generic-password', '-s', 'Supabase CLI', '-w'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore']
    }).trim()
  } catch {
    return null
  }
}

async function poolerHost() {
  const token = accessToken()
  if (token) {
    try {
      const response = await fetch(
        `https://api.supabase.com/v1/projects/${environment.ref}/config/database/pooler`,
        { headers: { Authorization: `Bearer ${token}` } }
      )
      if (response.ok) {
        const entries = await response.json()
        const primary = entries.find((entry) => entry.database_type === 'PRIMARY')
        if (primary?.db_host) return primary.db_host
      }
    } catch {
      // 아래에서 마지막으로 확인된 값으로 떨어진다.
    }
  }
  console.error(
    `풀러 호스트를 조회하지 못했습니다 — 마지막으로 확인된 ${environment.lastKnownPoolerHost} 로 시도합니다.`
  )
  return environment.lastKnownPoolerHost
}

async function databaseUrl() {
  // 비밀번호에 URL 예약문자가 있어도 안전하도록 인코딩한다.
  const password = encodeURIComponent(databasePassword())
  return `postgresql://postgres.${environment.ref}:${password}@${await poolerHost()}:5432/postgres`
}

const ARGUMENTS = {
  status: async () => ['migration', 'list', '--db-url', await databaseUrl()],
  migrate: async () => ['db', 'push', '--db-url', await databaseUrl()],
  functions: async () => ['functions', 'deploy', '--project-ref', environment.ref],
  config: async () => ['config', 'push', '--project-ref', environment.ref]
}

// 어디를 겨냥하는지 항상 보이게 한다 — 운영을 치는 명령이 조용해서는 안 된다.
console.error(`▶ ${environmentName} (${environment.ref}) — supabase ${action}`)

try {
  execFileSync(resolve('node_modules/.bin/supabase'), await ARGUMENTS[action](), {
    stdio: 'inherit'
  })
} catch (error) {
  process.exit(typeof error.status === 'number' ? error.status : 1)
}
