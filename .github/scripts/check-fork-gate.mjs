import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { DEFAULT_UPSTREAM_REPO } from './rewrite-fork-repository.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

export const FORK_GATE_TESTS = Object.freeze([
  'tests/sync-upstream-workflow.test.mjs',
  'tests/plugin-request-monitor.test.mjs',
  'tests/plugin-input-escape.test.mjs',
  'tests/host-tools.test.mjs',
  'tests/rollback-surface.test.mjs',
  'tests/polish-agent.test.mjs',
  'tests/transcript-row-plan.test.mjs',
  'tests/llm-stream-timeout.test.mjs',
  'tests/plugin-api.test.mjs',
  'tests/dsh-contract-check.test.mjs',
  'tests/host-sessions.test.mjs',
  'tests/settlement-temperature.test.mjs',
  'tests/profile-bridge-page.test.mjs',
])

export const LINUX_SYMLINK_TESTS = Object.freeze([
  'tests/desktop-profile-installation.test.mjs',
  'tests/profile-bridge-installation.test.mjs',
])

function inferRepository() {
  if (process.env.GITHUB_REPOSITORY) return process.env.GITHUB_REPOSITORY
  try {
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8'))
    const url = String(pkg?.repository?.url || pkg?.repository || '')
    const match = url.match(/github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/i)
    if (match) return match[1]
  } catch {}
  return ''
}

function runNode(args, label) {
  console.log(`\n==> ${label}`)
  const result = spawnSync(process.execPath, args, { cwd: REPO_ROOT, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) {
    throw new Error(`${label} 失败（退出码 ${result.status ?? 1}）`)
  }
}

export async function runForkGate({
  targetRepo = inferRepository(),
  skipTests = false,
  includeSymlinkTests = process.platform !== 'win32',
} = {}) {
  const staticChecks = [
    ['bin/build-image-client.mjs', '--check'],
    ['bin/build-tavern-client.mjs', '--check'],
    ['bin/build-installer-scripts.mjs', '--check'],
    ['bin/check-dsh-upgrade.mjs', '--check-dependencies'],
    ['tavern-plugin/packages/dsh-tavern-request-monitor/build.mjs', '--check'],
    ['tavern-plugin/packages/dsh-tavern-input-escape/build.mjs', '--check'],
  ]
  for (const args of staticChecks) {
    runNode(args, args.join(' '))
  }

  if (targetRepo && targetRepo !== DEFAULT_UPSTREAM_REPO) {
    runNode(
      ['.github/scripts/rewrite-fork-repository.mjs', '--check', '--repo', targetRepo],
      `rewrite-fork-repository --check (${targetRepo})`,
    )
  }

  if (!skipTests) {
    const testFiles = includeSymlinkTests
      ? [...FORK_GATE_TESTS, ...LINUX_SYMLINK_TESTS]
      : [...FORK_GATE_TESTS]
    runNode(['--test', ...testFiles], `核心纯 Node 单元测试 (${testFiles.length} 个文件)`)
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2)
  let targetRepo = inferRepository()
  let skipTests = false
  let includeSymlinkTests = process.platform !== 'win32'
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--repo' && i + 1 < args.length) targetRepo = args[++i]
    else if (args[i] === '--skip-tests') skipTests = true
    else if (args[i] === '--include-symlink-tests') includeSymlinkTests = true
    else if (args[i] === '--no-symlink-tests') includeSymlinkTests = false
  }
  await runForkGate({ targetRepo, skipTests, includeSymlinkTests })
}
