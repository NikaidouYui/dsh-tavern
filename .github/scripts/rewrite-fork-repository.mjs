import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

export const DEFAULT_UPSTREAM_REPO = 'flizzywine/dsh-tavern'

// 需要将仓库引用指向 Fork 的文件清单（与运行安装、插件打包、应用内更新及对应测试直接相关）。
export const TARGET_FILES = [
  'package.json',
  'install.ps1',
  'install.sh',
  'README.md',
  'android/setup.sh',
  'android/apk/prepare.py',
  'bin/application-update.mjs',
  'bin/install-next-plugin.ps1',
  'bin/launcher-environment.mjs',
  'tavern-plugin/lib/application-updater.js',
  'tavern-plugin/lib/domain/legacy-plugins.js',
  'tavern-plugin/packages/dsh-dream-skin/lib/font-assets.js',
  'tavern-plugin/packages/dsh-tavern/package.json',
  'tavern-plugin/packages/dsh-tavern/lib/installer-download.mjs',
  'tavern-plugin/packages/dsh-tavern/lib/state.mjs',
  'tavern-plugin/packages/dsh-tavern/client.js',
  'tavern-plugin/packages/dsh-tavern/README.md',
  'tests/desktop-profile-installation.test.mjs',
  'tests/profile-bridge-installation.test.mjs',
  'tests/profile-bridge-page.test.mjs',
]

function escapeRegex(value) {
  return value.replaceAll('/', '\\/')
}

function buildPairs(file, fromRepo, toRepo) {
  const fromEscaped = escapeRegex(fromRepo)
  const toEscaped = escapeRegex(toRepo)

  // README 只替换安装脚本、CDN、插件包与品牌资源地址，保留 Wiki、官网与独立 APK 下载地址，避免外链 404。
  if (file === 'README.md' || file === 'tavern-plugin/packages/dsh-tavern/README.md') {
    return [
      [`https://cdn.jsdelivr.net/gh/${fromRepo}@`, `https://cdn.jsdelivr.net/gh/${toRepo}@`],
      [`https://cdn.jsdelivr.net/gh/${fromRepo}/`, `https://cdn.jsdelivr.net/gh/${toRepo}/`],
      [`https://raw.githubusercontent.com/${fromRepo}/`, `https://raw.githubusercontent.com/${toRepo}/`],
      [`https://github.com/${fromRepo}/releases/download/launcher-current/`, `https://github.com/${toRepo}/releases/download/launcher-current/`],
    ]
  }

  return [
    [`git+https://github.com/${fromRepo}.git`, `git+https://github.com/${toRepo}.git`],
    [`https://github.com/${fromRepo}.git`, `https://github.com/${toRepo}.git`],
    [`https://github.com/${fromRepo}/releases/download/launcher-current/`, `https://github.com/${toRepo}/releases/download/launcher-current/`],
    [`https://github.com/${fromRepo}/commit/`, `https://github.com/${toRepo}/commit/`],
    [`https://github.com/${fromRepo}/issues`, `https://github.com/${toRepo}/issues`],
    [`https://github.com/${fromRepo}#readme`, `https://github.com/${toRepo}#readme`],
    [`https://api.github.com/repos/${fromRepo}/`, `https://api.github.com/repos/${toRepo}/`],
    [`https://raw.githubusercontent.com/${fromRepo}/`, `https://raw.githubusercontent.com/${toRepo}/`],
    [`https://cdn.jsdelivr.net/gh/${fromRepo}`, `https://cdn.jsdelivr.net/gh/${toRepo}`],
    [`https://codeload.github.com/${fromRepo}/`, `https://codeload.github.com/${toRepo}/`],
    [`github:${fromRepo}`, `github:${toRepo}`],
    [`'${fromRepo}'`, `'${toRepo}'`],
    [`:-${fromRepo}}`, `:-${toRepo}}`],
    [`${fromRepo}@`, `${toRepo}@`],
    [fromEscaped, toEscaped],
  ]
}

export function rewriteContent(file, text, targetRepo, upstreamRepo = DEFAULT_UPSTREAM_REPO) {
  if (!targetRepo || targetRepo === upstreamRepo) return text
  let result = text
  for (const [from, to] of buildPairs(file, upstreamRepo, targetRepo)) {
    result = result.replaceAll(from, to)
  }
  return result
}

export function restoreUpstreamContent(file, text, targetRepo, upstreamRepo = DEFAULT_UPSTREAM_REPO) {
  if (!targetRepo || targetRepo === upstreamRepo) return text
  let result = text
  for (const [from, to] of buildPairs(file, targetRepo, upstreamRepo)) {
    result = result.replaceAll(from, to)
  }
  return result
}

export async function rewriteRepository({
  root = process.cwd(),
  targetRepo = process.env.GITHUB_REPOSITORY || '',
  upstreamRepo = DEFAULT_UPSTREAM_REPO,
  check = false,
} = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(targetRepo)) {
    throw new Error(`无效的目标仓库名：${targetRepo || '<空>'}，请传入 --repo <owner/repo> 或设置 GITHUB_REPOSITORY`)
  }
  if (targetRepo === upstreamRepo) {
    return { changed: [], skipped: true }
  }

  const changed = []
  for (const file of TARGET_FILES) {
    const fullPath = path.join(root, file)
    let original
    try {
      original = await readFile(fullPath, 'utf8')
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    const next = rewriteContent(file, original, targetRepo, upstreamRepo)
    if (next === original) continue
    changed.push(file)
    if (!check) {
      await writeFile(fullPath, next, 'utf8')
    }
  }
  return { changed, skipped: false }
}

function parseArgs(argv) {
  const options = { check: false, targetRepo: process.env.GITHUB_REPOSITORY || '', upstreamRepo: DEFAULT_UPSTREAM_REPO }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--check') options.check = true
    else if (arg === '--repo') options.targetRepo = argv[++i] || ''
    else if (arg === '--upstream') options.upstreamRepo = argv[++i] || DEFAULT_UPSTREAM_REPO
  }
  return options
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseArgs(process.argv.slice(2))
  const result = await rewriteRepository(options)
  if (result.skipped) {
    console.log('目标仓库与上游相同，无需重写仓库引用。')
  } else if (options.check) {
    if (result.changed.length > 0) {
      console.error(`发现未指向 ${options.targetRepo} 的文件：\n${result.changed.join('\n')}`)
      process.exitCode = 1
    } else {
      console.log(`仓库引用检查通过：全部指向 ${options.targetRepo}。`)
    }
  } else {
    console.log(result.changed.length > 0
      ? `已更新以下文件的仓库引用为 ${options.targetRepo}：\n${result.changed.join('\n')}`
      : `仓库引用已是最新（${options.targetRepo}）。`)
  }
}
