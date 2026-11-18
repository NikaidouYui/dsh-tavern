import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DEFAULT_UPSTREAM_REPO, restoreUpstreamContent, rewriteContent, rewriteRepository, TARGET_FILES } from '../.github/scripts/rewrite-fork-repository.mjs'
import { syncUpstream } from '../.github/scripts/sync-upstream.mjs'

const REPO_ROOT = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const TEST_FORK_REPO = 'NikaidouYui/dsh-tavern'

test('rewriteContent 与 restoreUpstreamContent 对所有目标文件完全可逆', async () => {
  for (const file of TARGET_FILES) {
    const raw = await readFile(path.join(REPO_ROOT, file), 'utf8')
    const upstreamForm = restoreUpstreamContent(file, raw, TEST_FORK_REPO, DEFAULT_UPSTREAM_REPO)
    const rewritten = rewriteContent(file, upstreamForm, TEST_FORK_REPO, DEFAULT_UPSTREAM_REPO)
    const restored = restoreUpstreamContent(file, rewritten, TEST_FORK_REPO, DEFAULT_UPSTREAM_REPO)
    assert.equal(restored, upstreamForm, `文件 ${file} 还原后应与上游形态完全一致`)
  }
})

test('rewriteRepository 精确替换仓库引用并保留 Wiki/官网/APK/stable 引导外链', async t => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'dsh-tavern-rewrite-'))
  t.after(() => rm(tempRoot, { recursive: true, force: true }))

  for (const file of TARGET_FILES) {
    const source = path.join(REPO_ROOT, file)
    const target = path.join(tempRoot, file)
    await mkdir(path.dirname(target), { recursive: true })
    const raw = await readFile(source, 'utf8')
    await writeFile(target, restoreUpstreamContent(file, raw, TEST_FORK_REPO, DEFAULT_UPSTREAM_REPO), 'utf8')
  }

  const firstRun = await rewriteRepository({ root: tempRoot, targetRepo: TEST_FORK_REPO })
  assert.ok(firstRun.changed.includes('tavern-plugin/packages/dsh-tavern/package.json'))
  assert.ok(firstRun.changed.includes('tavern-plugin/packages/dsh-tavern/lib/installer-download.mjs'))
  assert.ok(firstRun.changed.includes('tavern-plugin/lib/application-updater.js'))
  assert.ok(firstRun.changed.includes('install.ps1'))
  assert.ok(firstRun.changed.includes('install.sh'))

  // 幂等性：再次检查应无待修改文件
  const checkRun = await rewriteRepository({ root: tempRoot, targetRepo: TEST_FORK_REPO, check: true })
  assert.deepEqual(checkRun.changed, [])

  // 核心代码、配置与插件包文件不应残留上游仓库地址（install.ps1/install.sh 中的 stable 引导外链除外）
  for (const file of [
    'package.json',
    'install.ps1',
    'install.sh',
    'android/setup.sh',
    'tavern-plugin/lib/application-updater.js',
    'tavern-plugin/packages/dsh-tavern/package.json',
    'tavern-plugin/packages/dsh-tavern/lib/installer-download.mjs',
    'tavern-plugin/packages/dsh-tavern/lib/state.mjs',
    'tavern-plugin/packages/dsh-tavern/client.js',
    'tavern-plugin/packages/dsh-dream-skin/lib/font-assets.js',
  ]) {
    const content = await readFile(path.join(tempRoot, file), 'utf8')
    const withoutStableGuide = content.replaceAll('https://github.com/flizzywine/dsh-tavern/blob/stable/README.md', '')
    assert.doesNotMatch(withoutStableGuide, /flizzywine(?:\\?\/)dsh-tavern/, `${file} 不应残留上游仓库引用`)
    assert.ok(content.includes(TEST_FORK_REPO) || content.includes(TEST_FORK_REPO.replace('/', '\\/')), `${file} 应包含 Fork 仓库引用`)
  }

  // README 保留 Wiki、官网与上游独立 APK 链接，同时替换安装/插件链接
  const readme = await readFile(path.join(tempRoot, 'README.md'), 'utf8')
  assert.ok(readme.includes(`https://github.com/${TEST_FORK_REPO}/releases/download/launcher-current/dsh-tavern.tgz`))
  assert.ok(readme.includes(`https://cdn.jsdelivr.net/gh/${TEST_FORK_REPO}@runtime-archive-main/install.ps1`))
  assert.ok(readme.includes('https://github.com/flizzywine/dsh-tavern/wiki/'))
  assert.ok(readme.includes('https://flizzywine.github.io/dsh-tavern/'))
  assert.ok(readme.includes('https://github.com/flizzywine/dsh-tavern/releases/download/v3.2/dsh-tavern-android-release.apk'))
})

test('Fork 与上游工作流配置隔离、引用脚本存在且职责边界清晰', async () => {
  const syncWorkflow = await readFile(path.join(REPO_ROOT, '.github/workflows/sync-upstream-and-release.yml'), 'utf8')
  assert.match(syncWorkflow, /cron:\s*'0 \*\/6 \* \* \*'/)
  assert.match(syncWorkflow, /workflow_dispatch:/)
  assert.match(syncWorkflow, /node \.github\/scripts\/sync-upstream\.mjs --report-conflict/)
  assert.match(syncWorkflow, /node \.github\/scripts\/check-fork-gate\.mjs/)
  assert.match(syncWorkflow, /GH_REPO:\s*\$\{\{\s*github\.repository\s*\}\}/)
  assert.match(syncWorkflow, /uses:\s*\.\/\.github\/workflows\/fork-release\.yml/)
  assert.match(syncWorkflow, /github\.repository\s*!=\s*'flizzywine\/dsh-tavern'/)

  const releaseWorkflow = await readFile(path.join(REPO_ROOT, '.github/workflows/fork-release.yml'), 'utf8')
  assert.match(releaseWorkflow, /workflow_call:/)
  assert.match(releaseWorkflow, /launcher-current/)
  assert.match(releaseWorkflow, /launcher-cdn-current/)
  assert.match(releaseWorkflow, /dsh-tavern\.tgz/)
  assert.match(releaseWorkflow, /node --experimental-vm-modules \.github\/scripts\/check-runtime-imports\.mjs/)
  assert.match(releaseWorkflow, /node-version:\s*'24'/)
  assert.match(releaseWorkflow, /node \.github\/scripts\/check-fork-gate\.mjs/)
  assert.match(releaseWorkflow, /github\.repository\s*!=\s*'flizzywine\/dsh-tavern'/)

  for (const upstreamWorkflow of [
    '.github/workflows/publish-runtime-manifest.yml',
    '.github/workflows/publish-official-launcher.yml',
    '.github/workflows/sync-launcher-readme.yml',
    '.github/workflows/publish-website.yml',
  ]) {
    const content = await readFile(path.join(REPO_ROOT, upstreamWorkflow), 'utf8')
    assert.match(content, /github\.repository\s*==\s*'flizzywine\/dsh-tavern'/, `${upstreamWorkflow} 必须限制仅在上游仓库运行`)
  }

  const manifestScript = await readFile(path.join(REPO_ROOT, '.github/scripts/write-runtime-manifest.mjs'), 'utf8')
  for (const excluded of [
    'tavern-plugin/packages/dsh-tavern-request-monitor/src/',
    'tavern-plugin/packages/dsh-tavern-request-monitor/build.mjs',
    'tavern-plugin/packages/dsh-tavern-input-escape/src/',
    'tavern-plugin/packages/dsh-tavern-input-escape/build.mjs',
  ]) {
    assert.ok(manifestScript.includes(excluded), `write-runtime-manifest.mjs 应排除开发期文件：${excluded}`)
  }

  await import('../.github/scripts/check-fork-gate.mjs')
})

test('Git 合并冲突场景：仅因仓库引用重指向引发的冲突可自动解决', async t => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'dsh-tavern-merge-'))
  t.after(() => rm(work, { recursive: true, force: true }))
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' })

  const repoDir = path.join(work, 'repo')
  await mkdir(repoDir)
  git(repoDir, 'init', '--initial-branch=upstream')
  git(repoDir, 'config', 'user.name', 'Test')
  git(repoDir, 'config', 'user.email', 'test@example.com')

  // 初始版本：包含 REPOSITORY 常量
  const targetFile = 'tavern-plugin/packages/dsh-tavern/lib/installer-download.mjs'
  await mkdir(path.dirname(path.join(repoDir, targetFile)), { recursive: true })
  await writeFile(path.join(repoDir, targetFile), "const REPOSITORY = 'flizzywine/dsh-tavern'\nexport const V = 1\n", 'utf8')
  git(repoDir, 'add', '.')
  git(repoDir, 'commit', '-m', 'init')

  // 创建 main 分支并重指向为 NikaidouYui/dsh-tavern
  git(repoDir, 'checkout', '-b', 'main')
  const forked = rewriteContent(targetFile, await readFile(path.join(repoDir, targetFile), 'utf8'), TEST_FORK_REPO, DEFAULT_UPSTREAM_REPO)
  await writeFile(path.join(repoDir, targetFile), forked, 'utf8')
  git(repoDir, 'add', '.')
  git(repoDir, 'commit', '-m', 'chore: rewrite repo')

  // 切回 upstream 分支紧挨同一行改动（制造标准 git merge 冲突）
  git(repoDir, 'checkout', 'upstream')
  await writeFile(path.join(repoDir, targetFile), "const REPOSITORY = 'flizzywine/dsh-tavern'\nexport const V = 2\n", 'utf8')
  git(repoDir, 'add', '.')
  git(repoDir, 'commit', '-m', 'upstream update')

  git(repoDir, 'checkout', 'main')
  let conflicted = false
  try {
    git(repoDir, 'merge', '--no-commit', '--no-ff', 'upstream')
  } catch {
    conflicted = true
  }
  assert.equal(conflicted, true, '应当触发 git 合并冲突以验证自动解决逻辑')

  const base = git(repoDir, 'show', `:1:${targetFile}`)
  const ours = git(repoDir, 'show', `:2:${targetFile}`)
  assert.equal(restoreUpstreamContent(targetFile, ours, TEST_FORK_REPO, DEFAULT_UPSTREAM_REPO), base)
  git(repoDir, 'checkout', '--theirs', '--', targetFile)
  const finalContent = rewriteContent(targetFile, await readFile(path.join(repoDir, targetFile), 'utf8'), TEST_FORK_REPO, DEFAULT_UPSTREAM_REPO)
  assert.equal(finalContent, `const REPOSITORY = '${TEST_FORK_REPO}'\nexport const V = 2\n`)
})

test('syncUpstream 端到端：跳过纯 manifest 提交、在 sync 分支自动合并并保留 ours 清单、遇真实代码冲突安全回退', async t => {
  const work = await mkdtemp(path.join(os.tmpdir(), 'dsh-tavern-e2e-sync-'))
  t.after(() => rm(work, { recursive: true, force: true }))
  const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim()

  const repoDir = path.join(work, 'repo')
  await mkdir(repoDir)
  git(repoDir, 'init', '--initial-branch=upstream')
  git(repoDir, 'config', 'user.name', 'Test')
  git(repoDir, 'config', 'user.email', 'test@example.com')

  const targetFile = 'tavern-plugin/packages/dsh-tavern/lib/installer-download.mjs'
  await mkdir(path.dirname(path.join(repoDir, targetFile)), { recursive: true })
  await writeFile(path.join(repoDir, targetFile), "const REPOSITORY = 'flizzywine/dsh-tavern'\nexport const V = 1\n", 'utf8')
  await writeFile(path.join(repoDir, 'dsh-tavern-runtime.json'), '{"source":"upstream","seq":1}\n', 'utf8')
  await writeFile(path.join(repoDir, 'core.js'), 'export const CORE = 1\n', 'utf8')
  git(repoDir, 'add', '.')
  git(repoDir, 'commit', '-m', 'init upstream')

  // Fork 基于同一初始提交，修改引用并保留自己的 runtime manifest
  git(repoDir, 'checkout', '-b', 'main')
  await rewriteRepository({ root: repoDir, targetRepo: TEST_FORK_REPO, upstreamRepo: DEFAULT_UPSTREAM_REPO })
  await writeFile(path.join(repoDir, 'dsh-tavern-runtime.json'), '{"source":"fork","seq":10}\n', 'utf8')
  git(repoDir, 'add', '.')
  git(repoDir, 'commit', '-m', 'chore: fork init')
  const forkMainBefore = git(repoDir, 'rev-parse', 'main')

  // 使用纯本地 git refs 模拟远端推送与镜像，避免沙箱环境下外部传输助手调用 sh.exe
  const remoteRefs = new Map()
  const localTransport = {
    fetchUpstream: () => git(repoDir, 'rev-parse', 'upstream'),
    pushMirror: ({ mirrorBranch, upstreamSha }) => {
      remoteRefs.set(mirrorBranch, upstreamSha)
      return { status: 0 }
    },
    pushSyncBranch: ({ syncBranch, headSha, upstreamSha }) => {
      const prevSha = remoteRefs.get(syncBranch)
      if (prevSha) {
        const localTree = git(repoDir, 'rev-parse', `${headSha}^{tree}`)
        const remoteTree = git(repoDir, 'rev-parse', `${prevSha}^{tree}`)
        let hasUpstream = true
        try {
          git(repoDir, 'merge-base', '--is-ancestor', upstreamSha, prevSha)
        } catch {
          hasUpstream = false
        }
        if (localTree === remoteTree && hasUpstream) return false
      }
      remoteRefs.set(syncBranch, headSha)
      return true
    },
  }

  // 1) 上游仅发布自动 runtime manifest 提交时，应直接跳过且不建同步分支
  git(repoDir, 'checkout', 'upstream')
  await writeFile(path.join(repoDir, 'dsh-tavern-runtime.json'), '{"source":"upstream","seq":2}\n', 'utf8')
  git(repoDir, 'add', 'dsh-tavern-runtime.json')
  git(repoDir, 'commit', '-m', 'chore: publish runtime manifest [skip ci]')
  const manifestOnlySha = git(repoDir, 'rev-parse', 'upstream')

  git(repoDir, 'checkout', 'main')
  const skipped = await syncUpstream({
    cwd: repoDir,
    targetRepo: TEST_FORK_REPO,
    targetBranch: 'main',
    syncBranch: 'sync/upstream-main',
    mirrorBranch: 'upstream-main',
    transport: localTransport,
  })
  assert.equal(skipped.status, 'skipped-manifest-only')
  assert.equal(git(repoDir, 'rev-parse', 'main'), forkMainBefore)
  assert.equal(remoteRefs.get('upstream-main'), manifestOnlySha)
  assert.equal(remoteRefs.has('sync/upstream-main'), false)

  // 2) 上游推进实质代码更新且紧挨引用行修改，同时更新 manifest：应推送 sync 分支、保留 ours manifest、不动 main
  git(repoDir, 'checkout', 'upstream')
  await writeFile(path.join(repoDir, targetFile), "const REPOSITORY = 'flizzywine/dsh-tavern'\nexport const V = 2\n", 'utf8')
  await writeFile(path.join(repoDir, 'dsh-tavern-runtime.json'), '{"source":"upstream","seq":3}\n', 'utf8')
  git(repoDir, 'add', '.')
  git(repoDir, 'commit', '-m', 'feat: upstream V=2')

  git(repoDir, 'checkout', 'main')
  const ready = await syncUpstream({
    cwd: repoDir,
    targetRepo: TEST_FORK_REPO,
    targetBranch: 'main',
    syncBranch: 'sync/upstream-main',
    mirrorBranch: 'upstream-main',
    transport: localTransport,
  })
  assert.equal(ready.status, 'ready')
  assert.equal(ready.pushed, true)
  assert.ok(ready.autoResolvedFiles.includes(targetFile))
  assert.ok(ready.autoResolvedFiles.includes('dsh-tavern-runtime.json'))
  assert.equal(git(repoDir, 'rev-parse', 'main'), forkMainBefore, '同步绝不能直接修改 main')
  assert.match(await readFile(path.join(repoDir, targetFile), 'utf8'), /NikaidouYui\/dsh-tavern/)
  assert.match(await readFile(path.join(repoDir, targetFile), 'utf8'), /export const V = 2/)
  assert.equal(await readFile(path.join(repoDir, 'dsh-tavern-runtime.json'), 'utf8'), '{"source":"fork","seq":10}\n')

  // 3) 切回 main 并制造同一行真实代码冲突：应安全中止并报告 conflictFiles，不污染工作区
  git(repoDir, 'checkout', 'main')
  await writeFile(path.join(repoDir, 'core.js'), 'export const CORE = 999\n', 'utf8')
  git(repoDir, 'add', 'core.js')
  git(repoDir, 'commit', '-m', 'feat: fork core change')

  git(repoDir, 'checkout', 'upstream')
  await writeFile(path.join(repoDir, 'core.js'), 'export const CORE = 2\n', 'utf8')
  git(repoDir, 'add', 'core.js')
  git(repoDir, 'commit', '-m', 'feat: upstream core change')

  git(repoDir, 'checkout', 'main')
  const conflict = await syncUpstream({
    cwd: repoDir,
    targetRepo: TEST_FORK_REPO,
    targetBranch: 'main',
    syncBranch: 'sync/upstream-main',
    mirrorBranch: 'upstream-main',
    allowConflictReturn: true,
    transport: localTransport,
  })
  assert.equal(conflict.status, 'conflict')
  assert.deepEqual(conflict.conflictFiles, ['core.js'])
  assert.equal(git(repoDir, 'status', '--porcelain'), '', '冲突中止后工作区必须保持干净')
})
