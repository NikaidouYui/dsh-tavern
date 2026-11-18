import { copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readPluginFiles } from '../../tavern-plugin/lib/domain/user-plugin-install.js'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

export const TAVERN_PLUGIN_TARGETS = Object.freeze([
  {
    name: 'dsh-tavern-request-monitor',
    sourceDir: 'tavern-plugin/packages/dsh-tavern-request-monitor',
    branch: 'plugin-request-monitor',
    zipName: 'dsh-tavern-request-monitor.zip',
  },
  {
    name: 'dsh-tavern-input-escape',
    sourceDir: 'tavern-plugin/packages/dsh-tavern-input-escape',
    branch: 'plugin-input-escape',
    zipName: 'dsh-tavern-input-escape.zip',
  },
])

const EXCLUDED_NAMES = new Set([
  '.git',
  '.github',
  'node_modules',
  'src',
  'tests',
  'build.mjs',
  'cordis.patch.yml',
])

const EXCLUDED_SUFFIXES = ['.zip', '.tgz', '.tmp']

function shouldSkip(entryName) {
  if (EXCLUDED_NAMES.has(entryName)) return true
  if (entryName.startsWith('.tavern-')) return true
  return EXCLUDED_SUFFIXES.some(suffix => entryName.endsWith(suffix))
}

async function collectFiles(dir, prefix = '', out = new Map()) {
  const entries = await readdir(dir, { withFileTypes: true })
  entries.sort((a, b) => a.name.localeCompare(b.name))
  for (const entry of entries) {
    if (shouldSkip(entry.name)) continue
    const full = path.join(dir, entry.name)
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      await collectFiles(full, rel, out)
    } else if (entry.isFile()) {
      out.set(rel, await readFile(full))
    }
  }
  return out
}

/**
 * 将工作区内的独立插件整理为可直接作为 GitHub 分支根或 ZIP 根安装的纯净发布目录，
 * 并复用 Tavern 插件安装器自身的 `readPluginFiles` 验证结构完整性。
 */
export async function stageTavernPlugin(target, destDir, { repoRoot = REPO_ROOT } = {}) {
  const sourceRoot = path.resolve(repoRoot, target.sourceDir)
  const info = await stat(sourceRoot).catch(() => null)
  if (!info || !info.isDirectory()) {
    throw new Error(`找不到插件目录：${sourceRoot}`)
  }

  // 若插件包含 build.mjs，先校验 client.js 与源码同步
  const buildScript = path.join(sourceRoot, 'build.mjs')
  const hasBuild = await stat(buildScript).then(s => s.isFile()).catch(() => false)
  if (hasBuild) {
    const mod = await import(pathToFileURL(buildScript).href)
    const fn = Object.values(mod).find(v => typeof v === 'function')
    if (fn) {
      await fn({ check: true, packageRoot: pathToFileURL(sourceRoot + path.sep) })
    }
  }

  const collected = await collectFiles(sourceRoot)
  // 用酒馆真实安装校验器（readPluginFiles）确保包名、版本、exports 入口和零未打包依赖全部合格
  const validated = readPluginFiles(collected)
  if (validated.pkg.name !== target.name) {
    throw new Error(`插件包名不匹配：期望 ${target.name}，实际 ${validated.pkg.name}`)
  }

  const outDir = path.resolve(destDir)
  await rm(outDir, { recursive: true, force: true })
  await mkdir(outDir, { recursive: true })

  let totalBytes = 0
  for (const [relative, buf] of collected) {
    const destFile = path.join(outDir, ...relative.split('/'))
    await mkdir(path.dirname(destFile), { recursive: true })
    await copyFile(path.join(sourceRoot, ...relative.split('/')), destFile)
    totalBytes += buf.length
  }

  return {
    name: validated.pkg.name,
    version: String(validated.pkg.version),
    branch: target.branch,
    zipName: target.zipName,
    fileCount: collected.size,
    totalBytes,
    files: [...collected.keys()],
  }
}

function parseCliArgs(argv) {
  const args = {}
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]
    if (token === '--list-json') args.listJson = true
    else if (token === '--plugin' && i + 1 < argv.length) args.plugin = argv[++i]
    else if (token === '--dest' && i + 1 < argv.length) args.dest = argv[++i]
  }
  return args
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = parseCliArgs(process.argv.slice(2))
  if (args.listJson) {
    console.log(JSON.stringify(TAVERN_PLUGIN_TARGETS))
    process.exit(0)
  }
  const selected = args.plugin
    ? TAVERN_PLUGIN_TARGETS.filter(item => item.name === args.plugin)
    : TAVERN_PLUGIN_TARGETS
  if (!selected.length) {
    throw new Error(`未找到插件配置：${args.plugin}`)
  }
  if (!args.dest) {
    throw new Error('缺少 --dest 输出目录参数')
  }
  for (const item of selected) {
    const targetDir = selected.length === 1 ? args.dest : path.join(args.dest, item.name)
    const result = await stageTavernPlugin(item, targetDir)
    console.log(JSON.stringify(result))
  }
}
