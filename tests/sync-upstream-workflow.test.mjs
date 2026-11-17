import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { DEFAULT_UPSTREAM_REPO, restoreUpstreamContent, rewriteContent, rewriteRepository, TARGET_FILES } from '../.github/scripts/rewrite-fork-repository.mjs'

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

test('sync-upstream-and-release workflow 引用的脚本均存在且配置正确', async () => {
  const workflow = await readFile(path.join(REPO_ROOT, '.github/workflows/sync-upstream-and-release.yml'), 'utf8')
  assert.match(workflow, /cron:\s*'0 \*\/6 \* \* \*'/)
  assert.match(workflow, /workflow_dispatch:/)
  assert.match(workflow, /node \.github\/scripts\/sync-upstream\.mjs/)
  assert.match(workflow, /launcher-current/)
  assert.match(workflow, /launcher-cdn-current/)
  assert.match(workflow, /dsh-tavern\.tgz/)
  await import('../.github/scripts/sync-upstream.mjs')
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
