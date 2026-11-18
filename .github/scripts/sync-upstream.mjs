import { execFileSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { DEFAULT_UPSTREAM_REPO, restoreUpstreamContent, rewriteRepository, TARGET_FILES } from './rewrite-fork-repository.mjs'

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')

// 上游纯运行清单变更在合并时保留 Fork 自身版本，交由后续发布流按 Fork 状态重建
const GENERATED_KEEP_OURS = new Set([
  'dsh-tavern-runtime.json',
])

// 启动器 README 冲突先取上游最新正文，随后由同步脚本重生成并改写仓库引用
const GENERATED_TAKE_THEIRS = new Set([
  'tavern-plugin/packages/dsh-tavern/README.md',
])

// 若上游相对共同祖先仅改动此类自动生成清单，则跳过无效同步
const IGNORABLE_UPSTREAM_FILES = new Set([
  'dsh-tavern-runtime.json',
])

function git(args, { cwd = process.cwd(), allowFailure = false, encoding = 'utf8' } = {}) {
  const result = spawnSync('git', args, { cwd, encoding, maxBuffer: 32 * 1024 * 1024 })
  if (result.status !== 0 && !allowFailure) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim()
    throw new Error(`git ${args.join(' ')} 失败（退出码 ${result.status}）：${detail}`)
  }
  return result
}

function gitText(args, options) {
  return git(args, options).stdout.trim()
}

function gitStageBlob(stage, file, options) {
  const result = git(['show', `:${stage}:${file}`], { ...options, allowFailure: true })
  return result.status === 0 ? result.stdout : null
}

function isMergeInProgress(cwd) {
  return existsSync(path.join(cwd, '.git/MERGE_HEAD'))
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

async function defaultSyncDerived({ cwd, targetRepo, upstreamRepo }) {
  await rewriteRepository({ root: cwd, targetRepo, upstreamRepo })
  if (path.resolve(cwd) === REPO_ROOT && existsSync(path.join(cwd, '.github/scripts/sync-launcher-readme.mjs'))) {
    execFileSync(process.execPath, [path.join(cwd, '.github/scripts/sync-launcher-readme.mjs')], { cwd, stdio: 'inherit' })
    await rewriteRepository({ root: cwd, targetRepo, upstreamRepo })
  }
  if (existsSync(path.join(cwd, 'bin/build-installer-scripts.mjs'))) {
    execFileSync(process.execPath, [path.join(cwd, 'bin/build-installer-scripts.mjs')], { cwd, stdio: 'inherit' })
    execFileSync(process.execPath, [path.join(cwd, 'bin/build-installer-scripts.mjs'), '--check'], { cwd, stdio: 'inherit' })
  }
}

function emitOutputs(payload) {
  setOutput('status', payload.status)
  setOutput('merged', String(payload.merged))
  setOutput('committed', String(payload.committed))
  setOutput('pushed', String(payload.pushed))
  setOutput('sync_branch', payload.syncBranch)
  setOutput('head_sha', payload.headSha)
  setOutput('upstream_sha', payload.upstreamSha)
  setOutput('short_upstream_sha', payload.shortUpstreamSha)
  setOutput('upstream_commits', payload.upstreamCommits)
  setOutput('conflict_files', payload.conflictFiles.join('\n'))
  setOutput('auto_resolved_files', payload.autoResolvedFiles.join('\n'))
}

function createGitTransport(gitOpts) {
  return {
    fetchUpstream({ upstreamUrl, upstreamBranch }) {
      const hasUpstream = git(['remote', 'get-url', 'upstream'], { ...gitOpts, allowFailure: true }).status === 0
      if (hasUpstream) {
        git(['remote', 'set-url', 'upstream', upstreamUrl], gitOpts)
      } else {
        git(['remote', 'add', 'upstream', upstreamUrl], gitOpts)
      }
      git(['fetch', '--no-tags', 'upstream', upstreamBranch], gitOpts)
      return gitText(['rev-parse', 'FETCH_HEAD'], gitOpts)
    },
    pushMirror({ mirrorBranch, upstreamSha }) {
      return git(['push', 'origin', `${upstreamSha}:refs/heads/${mirrorBranch}`], { ...gitOpts, allowFailure: true })
    },
    pushSyncBranch({ syncBranch, headSha, upstreamSha }) {
      const remoteProbe = git(['ls-remote', '--heads', 'origin', syncBranch], { ...gitOpts, allowFailure: true })
      const remoteSha = remoteProbe.stdout?.trim().split(/\s+/)[0] || ''
      if (remoteSha) {
        const fetchRemote = git(['fetch', '--no-tags', 'origin', syncBranch], { ...gitOpts, allowFailure: true })
        if (fetchRemote.status === 0) {
          const localTree = gitText(['rev-parse', `${headSha}^{tree}`], gitOpts)
          const remoteTree = gitText(['rev-parse', 'FETCH_HEAD^{tree}'], gitOpts)
          const remoteHasUpstream = git(['merge-base', '--is-ancestor', upstreamSha, 'FETCH_HEAD'], { ...gitOpts, allowFailure: true }).status === 0
          if (localTree === remoteTree && remoteHasUpstream) {
            return false
          }
        }
      }
      git(['push', '--force', 'origin', `HEAD:refs/heads/${syncBranch}`], gitOpts)
      return true
    },
  }
}

export async function syncUpstream({
  cwd = process.cwd(),
  upstreamRepo = process.env.UPSTREAM_REPO || DEFAULT_UPSTREAM_REPO,
  upstreamBranch = process.env.UPSTREAM_BRANCH || 'main',
  upstreamUrl = '',
  targetRepo = process.env.GITHUB_REPOSITORY || '',
  targetBranch = process.env.GITHUB_REF_NAME || 'main',
  syncBranch = process.env.SYNC_BRANCH || `sync/upstream-${targetBranch}`,
  mirrorBranch = process.env.UPSTREAM_MIRROR_BRANCH ?? 'upstream-main',
  forceSync = process.env.FORCE_SYNC === 'true',
  push = process.env.SKIP_PUSH !== 'true',
  allowConflictReturn = process.argv.includes('--report-conflict'),
  syncDerived = defaultSyncDerived,
  transport = null,
} = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(upstreamRepo)) {
    throw new Error(`无效的上游仓库名：${upstreamRepo}`)
  }
  if (!/^[\w.-]+\/[\w.-]+$/.test(targetRepo)) {
    throw new Error(`无效的目标仓库名：${targetRepo}`)
  }

  const gitOpts = { cwd }
  const activeTransport = transport || createGitTransport(gitOpts)
  git(['config', 'user.name', 'github-actions[bot]'], gitOpts)
  git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com'], gitOpts)

  const resolvedUpstreamUrl = upstreamUrl || `https://github.com/${upstreamRepo}.git`
  const upstreamSha = activeTransport.fetchUpstream({ upstreamUrl: resolvedUpstreamUrl, upstreamBranch })
  const shortUpstreamSha = upstreamSha.slice(0, 8)
  const baseSha = gitText(['rev-parse', 'HEAD'], gitOpts)

  // 维护 Fork 仓库内的纯净上游镜像分支，方便随时在本地或网页切 PR 反馈上游
  if (push && mirrorBranch) {
    const mirrorPush = activeTransport.pushMirror({ mirrorBranch, upstreamSha })
    if (mirrorPush && mirrorPush.status !== 0) {
      console.warn(`::warning::更新纯净镜像分支 ${mirrorBranch} 跳过（可能存在非快进差异或包含 .github/workflows 变更）：${mirrorPush.stderr || mirrorPush.stdout}`)
    }
  }

  const alreadyAncestor = git(['merge-base', '--is-ancestor', upstreamSha, 'HEAD'], { ...gitOpts, allowFailure: true }).status === 0
  if (alreadyAncestor) {
    const payload = {
      status: 'up-to-date',
      merged: false,
      committed: false,
      pushed: false,
      syncBranch,
      headSha: baseSha,
      upstreamSha,
      shortUpstreamSha,
      upstreamCommits: '',
      conflictFiles: [],
      autoResolvedFiles: [],
    }
    emitOutputs(payload)
    return payload
  }

  const mergeBase = gitText(['merge-base', 'HEAD', upstreamSha], gitOpts)
  const changedFromBase = gitText(['diff', '--name-only', `${mergeBase}..${upstreamSha}`], gitOpts)
    .split(/\r?\n/)
    .filter(Boolean)
  const hasMeaningfulChanges = changedFromBase.some(file => !IGNORABLE_UPSTREAM_FILES.has(file))

  if (!forceSync && !hasMeaningfulChanges) {
    console.log(`上游 ${upstreamRepo}@${upstreamBranch} (${shortUpstreamSha}) 仅更新了自动生成的运行清单，跳过本次同步。`)
    const payload = {
      status: 'skipped-manifest-only',
      merged: false,
      committed: false,
      pushed: false,
      syncBranch,
      headSha: baseSha,
      upstreamSha,
      shortUpstreamSha,
      upstreamCommits: '',
      conflictFiles: [],
      autoResolvedFiles: [],
    }
    emitOutputs(payload)
    return payload
  }

  const upstreamCommits = gitText(['log', '--oneline', '--max-count=30', `HEAD..${upstreamSha}`], gitOpts)
  // 在独立同步分支中合并上游，不直接污染 main
  git(['checkout', '-B', syncBranch, baseSha], gitOpts)

  const autoResolvedFiles = []
  const manualConflicts = []
  const mergeResult = git(['merge', '--no-commit', '--no-ff', upstreamSha], { ...gitOpts, allowFailure: true })

  if (mergeResult.status !== 0) {
    const conflicts = gitText(['diff', '--name-only', '--diff-filter=U'], gitOpts).split(/\r?\n/).filter(Boolean)
    const targetSet = new Set(TARGET_FILES)

    for (const file of conflicts) {
      if (GENERATED_KEEP_OURS.has(file)) {
        git(['checkout', '--ours', '--', file], gitOpts)
        git(['add', '--', file], gitOpts)
        autoResolvedFiles.push(file)
        continue
      }
      if (GENERATED_TAKE_THEIRS.has(file)) {
        git(['checkout', '--theirs', '--', file], gitOpts)
        git(['add', '--', file], gitOpts)
        autoResolvedFiles.push(file)
        continue
      }
      if (targetSet.has(file)) {
        const base = gitStageBlob(1, file, gitOpts)
        const ours = gitStageBlob(2, file, gitOpts)
        if (base !== null && ours !== null) {
          const restored = restoreUpstreamContent(file, ours, targetRepo, upstreamRepo)
          if (restored.replaceAll('\r\n', '\n') === base.replaceAll('\r\n', '\n')) {
            console.log(`自动解决仓库引用替换导致的冲突：${file}`)
            git(['checkout', '--theirs', '--', file], gitOpts)
            git(['add', '--', file], gitOpts)
            autoResolvedFiles.push(file)
            continue
          }
        }
      }
      manualConflicts.push(file)
    }

    if (manualConflicts.length > 0) {
      git(['merge', '--abort'], { ...gitOpts, allowFailure: true })
      git(['checkout', '--detach', baseSha], { ...gitOpts, allowFailure: true })
      git(['branch', '-D', syncBranch], { ...gitOpts, allowFailure: true })

      const message = `合并上游 ${upstreamRepo}@${upstreamBranch} (${shortUpstreamSha}) 到 ${targetBranch} 时存在无法自动解决的代码冲突：\n${manualConflicts.map(f => `- ${f}`).join('\n')}`
      appendSummary(`### 同步上游存在代码冲突\n\n${message}\n\n#### 本地解决建议\n\`\`\`sh\ngit fetch upstream ${upstreamBranch}\ngit checkout ${targetBranch}\ngit merge --no-ff upstream/${upstreamBranch}\n# 解决上述冲突并测试通过后推送 origin ${targetBranch}\n\`\`\``)

      const payload = {
        status: 'conflict',
        merged: false,
        committed: false,
        pushed: false,
        syncBranch,
        headSha: baseSha,
        upstreamSha,
        shortUpstreamSha,
        upstreamCommits,
        conflictFiles: manualConflicts,
        autoResolvedFiles,
      }
      emitOutputs(payload)
      if (allowConflictReturn) {
        return payload
      }
      throw new Error(message)
    }
  }

  // 重写仓库引用为当前 Fork，并同步内嵌安装脚本与启动器 README
  await syncDerived({ cwd, targetRepo, upstreamRepo })

  git(['add', '-A'], gitOpts)
  const hasStaged = git(['diff', '--cached', '--quiet'], { ...gitOpts, allowFailure: true }).status !== 0
  let committed = false
  if (isMergeInProgress(cwd) || hasStaged) {
    git(['commit', '-m', `chore: sync upstream ${upstreamRepo}@${upstreamBranch} (${shortUpstreamSha})`], gitOpts)
    committed = true
  }

  const headSha = gitText(['rev-parse', 'HEAD'], gitOpts)
  let pushed = false

  if (push && committed) {
    pushed = activeTransport.pushSyncBranch({ syncBranch, headSha, upstreamSha })
    if (!pushed) {
      console.log(`远端同步分支 ${syncBranch} 已包含 ${shortUpstreamSha} 且内容树完全一致，跳过重复推送。`)
    }
  }

  const payload = {
    status: 'ready',
    merged: true,
    committed,
    pushed,
    syncBranch,
    headSha,
    upstreamSha,
    shortUpstreamSha,
    upstreamCommits,
    conflictFiles: [],
    autoResolvedFiles,
  }
  emitOutputs(payload)
  console.log(JSON.stringify(payload, null, 2))
  return payload
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await syncUpstream()
}
