import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { DEFAULT_UPSTREAM_REPO, restoreUpstreamContent, rewriteRepository, TARGET_FILES } from './rewrite-fork-repository.mjs'

const GENERATED_FILES = new Set([
  'dsh-tavern-runtime.json',
  'tavern-plugin/packages/dsh-tavern/README.md',
])

function git(args, { allowFailure = false, encoding = 'utf8' } = {}) {
  const result = spawnSync('git', args, { encoding, maxBuffer: 32 * 1024 * 1024 })
  if (result.status !== 0 && !allowFailure) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`git ${args.join(' ')} 失败（退出码 ${result.status}）：${detail}`)
  }
  return result
}

function gitText(args) {
  return git(args).stdout.trim()
}

function gitStageBlob(stage, file) {
  const result = git(['show', `:${stage}:${file}`], { allowFailure: true })
  return result.status === 0 ? result.stdout : null
}

function isMergeInProgress() {
  return existsSync(path.join(process.cwd(), '.git/MERGE_HEAD'))
}

function setOutput(name, value) {
  const file = process.env.GITHUB_OUTPUT
  if (!file) return
  const text = String(value)
  if (text.includes('\n')) {
    const delimiter = `EOF_${Date.now()}_${Math.random().toString(16).slice(2)}`
    appendFileSync(file, `${name}<<${delimiter}\n${text}\n${delimiter}\n`, 'utf8')
  } else {
    appendFileSync(file, `${name}=${text}\n`, 'utf8')
  }
}

function appendSummary(markdown) {
  const file = process.env.GITHUB_STEP_SUMMARY
  if (file) appendFileSync(file, `${markdown}\n`, 'utf8')
}

export async function syncUpstream({
  upstreamRepo = process.env.UPSTREAM_REPO || DEFAULT_UPSTREAM_REPO,
  upstreamBranch = process.env.UPSTREAM_BRANCH || 'main',
  targetRepo = process.env.GITHUB_REPOSITORY || '',
  targetBranch = process.env.GITHUB_REF_NAME || 'main',
} = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(upstreamRepo)) {
    throw new Error(`无效的上游仓库名：${upstreamRepo}`)
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(targetRepo)) {
    throw new Error(`无效的目标仓库名：${targetRepo}`)
  }

  git(['config', 'user.name', 'github-actions[bot]'])
  git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'])

  const upstreamUrl = `https://github.com/${upstreamRepo}.git`
  const hasUpstream = git(['remote', 'get-url', 'upstream'], { allowFailure: true }).status === 0
  if (hasUpstream) {
    git(['remote', 'set-url', 'upstream', upstreamUrl])
  } else {
    git(['remote', 'add', 'upstream', upstreamUrl])
  }

  git(['fetch', '--no-tags', 'upstream', upstreamBranch])
  const upstreamSha = gitText(['rev-parse', 'FETCH_HEAD'])
  const shortUpstreamSha = upstreamSha.slice(0, 8)

  const alreadyAncestor = git(['merge-base', '--is-ancestor', upstreamSha, 'HEAD'], { allowFailure: true }).status === 0
  let merged = false
  let upstreamCommits = ''

  if (!alreadyAncestor) {
    upstreamCommits = gitText(['log', '--oneline', '--max-count=30', `HEAD..${upstreamSha}`])
    const mergeResult = git(['merge', '--no-commit', '--no-ff', upstreamSha], { allowFailure: true })
    if (mergeResult.status !== 0) {
      const conflicts = gitText(['diff', '--name-only', '--diff-filter=U']).split(/\r?\n/).filter(Boolean)
      const manualConflicts = []
      const targetSet = new Set(TARGET_FILES)

      for (const file of conflicts) {
        if (GENERATED_FILES.has(file)) {
          git(['checkout', '--theirs', '--', file])
          git(['add', '--', file])
          continue
        }
        if (targetSet.has(file)) {
          const base = gitStageBlob(1, file)
          const ours = gitStageBlob(2, file)
          if (base !== null && ours !== null) {
            const restored = restoreUpstreamContent(file, ours, targetRepo, upstreamRepo)
            if (restored.replaceAll('\r\n', '\n') === base.replaceAll('\r\n', '\n')) {
              console.log(`自动解决仓库引用替换导致的冲突：${file}`)
              git(['checkout', '--theirs', '--', file])
              git(['add', '--', file])
              continue
            }
          }
        }
        manualConflicts.push(file)
      }

      if (manualConflicts.length > 0) {
        git(['merge', '--abort'], { allowFailure: true })
        const message = `合并上游 ${upstreamRepo}@${upstreamBranch} (${shortUpstreamSha}) 时存在无法自动解决的代码冲突：\n${manualConflicts.map(f => `- ${f}`).join('\n')}`
        appendSummary(`### 同步上游失败\n\n${message}`)
        throw new Error(message)
      }
    }
    merged = true
  }

  // 重写仓库引用为当前 Fork，并同步内嵌安装脚本与启动器 README。
  await rewriteRepository({ targetRepo, upstreamRepo })
  execFileSync(process.execPath, [fileURLToPath(new URL('./sync-launcher-readme.mjs', import.meta.url))], { stdio: 'inherit' })
  await rewriteRepository({ targetRepo, upstreamRepo })
  execFileSync(process.execPath, ['bin/build-installer-scripts.mjs'], { stdio: 'inherit' })
  execFileSync(process.execPath, ['bin/build-installer-scripts.mjs', '--check'], { stdio: 'inherit' })

  git(['add', '-A'])
  const hasStaged = git(['diff', '--cached', '--quiet'], { allowFailure: true }).status !== 0
  let committed = false

  if (isMergeInProgress() || hasStaged) {
    const message = merged
      ? `chore: sync upstream ${upstreamRepo}@${upstreamBranch} (${shortUpstreamSha})`
      : `chore: point repository references to ${targetRepo}`
    git(['commit', '-m', message])
    committed = true
  }

  if (committed) {
    for (let attempt = 1; attempt <= 3; attempt++) {
      const push = git(['push', 'origin', `HEAD:${targetBranch}`], { allowFailure: true })
      if (push.status === 0) break
      if (attempt === 3) {
        throw new Error(`推送到 origin/${targetBranch} 失败：${push.stderr || push.stdout}`)
      }
      git(['fetch', 'origin', targetBranch])
      git(['merge', '--no-edit', 'FETCH_HEAD'])
    }
  }

  const headSha = gitText(['rev-parse', 'HEAD'])
  setOutput('merged', String(merged))
  setOutput('committed', String(committed))
  setOutput('head_sha', headSha)
  setOutput('upstream_sha', upstreamSha)
  setOutput('upstream_commits', upstreamCommits)

  console.log(JSON.stringify({ merged, committed, headSha, upstreamSha, targetRepo, targetBranch }, null, 2))
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await syncUpstream()
}
