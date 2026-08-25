import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import electron from 'electron'
import { readAppVersions } from '../e2e/fixtures.mjs'

const args = new Set(process.argv.slice(2))
const unknown = [...args].filter((arg) => arg !== '--build' && arg !== '--fresh')
if (unknown.length > 0) {
  throw new Error(`Unknown option${unknown.length > 1 ? 's' : ''}: ${unknown.join(', ')}`)
}

const appDir = resolve(import.meta.dirname, '..')
const sandboxRoot = resolve(appDir, '.wooi-dev')
const userDataPath = resolve(sandboxRoot, 'userdata')
const wooiHomePath = resolve(sandboxRoot, 'home')
const entryPath = join(appDir, 'out/main/index.js')

function run(command, commandArgs, options = {}) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(command, commandArgs, { stdio: 'inherit', ...options })
    child.once('error', reject)
    child.once('exit', (code, signal) => {
      if (signal) reject(new Error(`${command} exited from signal ${signal}`))
      else if (code === 0) resolveRun()
      else reject(new Error(`${command} exited with code ${code}`))
    })
  })
}

if (args.has('--fresh')) {
  console.log(`Removing sandbox data at ${sandboxRoot}`)
  await rm(sandboxRoot, { recursive: true, force: true })
}

if (args.has('--build') || !existsSync(entryPath)) {
  console.log(
    args.has('--build')
      ? 'Rebuilding the app because --build was requested...'
      : 'Built app not found; running npm run build first...'
  )
  await run('npm', ['run', 'build'], { cwd: appDir })
}

await Promise.all([
  mkdir(userDataPath, { recursive: true }),
  mkdir(wooiHomePath, { recursive: true })
])

const storePath = join(userDataPath, 'wooi.json')
if (!existsSync(storePath)) {
  const { schemaVersion, termsVersion } = await readAppVersions({ appDir })
  await writeFile(
    storePath,
    JSON.stringify(
      {
        schemaVersion,
        repos: [],
        workspaces: [],
        fanoutGroups: [],
        reviews: [],
        settings: {
          onboarded: true,
          pickedDefaults: true,
          acceptedTermsVersion: termsVersion
        }
      },
      null,
      2
    )
  )
  console.log(`Seeded sandbox state at ${storePath}`)
}

if (!isAbsolute(userDataPath)) {
  throw new Error(`Sandbox user-data path must be absolute: ${userDataPath}`)
}

// 격리를 끄고 user-data 인자를 빠뜨리면 설치된 Wooi의 실제 데이터로 조용히 폴백해 망가뜨린다.
const launchArgs = [entryPath, `--user-data-dir=${userDataPath}`]
const launchEnv = {
  ...process.env,
  WOOI_DEV_ISOLATION: '0',
  WOOI_HOME: wooiHomePath
}

console.log(`Launching sandbox with user data at ${userDataPath}`)
const app = spawn(electron, launchArgs, {
  cwd: appDir,
  env: launchEnv,
  stdio: 'inherit'
})

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => app.kill(signal))
}

app.once('error', (error) => {
  console.error(error)
  process.exitCode = 1
})
app.once('exit', (code, signal) => {
  process.exitCode = code ?? (signal ? 1 : 0)
})
