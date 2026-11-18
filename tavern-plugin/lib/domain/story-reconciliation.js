import { randomUUID } from 'node:crypto'
import { repairNativeSurface, recordNativeSurfaceRepair, planNativeSurfaceRepair } from './native-surface-repair.js'
import { reshadowRolledBackRounds } from './rollback-surface.js'
import { clearSurfaceEditTurns, markSurfaceEditTurn, releaseOpeningTurn, reserveStoryTurns, sessionEvents, withSuppressedEditLifecycle } from './session-events.js'
import { inspectStoryAlignment, nativeStoryTurns } from './story-alignment.js'

function str(value) {
  return typeof value === 'string' ? value : (value === undefined || value === null ? '' : String(value))
}

// Bring the save and the native session back into agreement before anything
// acts on "the latest round" (#196): record a round the save missed, re-shadow
// a rolled-back round the model still sees, and rewrite the native tail from the
// save when their text drifted. The save is the truth. Never blocks the caller.
export function createStoryReconciliation({ agentRegistry, sessionStore, chatForSession, chatSliceForSession, updateChat, turns, ensurePrefix }) {
  const liveSession = sessionId => sessionStore.get(sessionId) || agentRegistry.get(sessionId)?.session
  // Reconciling writes the save: never while a turn of that session runs, where
  // it would wait on the very turn it shares the template runtime with.
  const reconciledSessions = new Set(), reconciling = new Map()

  async function reconcileWhenIdle(sessionId, { once = false } = {}) {
    sessionId = str(sessionId)
    if (!sessionId || (once && reconciledSessions.has(sessionId))) return null
    // Any phase but idle may be a turn being prepared; reconciling then would race it.
    // The agent phase can still read idle while a turn's hooks run, so an open
    // turn in the log (started, not ended) counts as busy too.
    const busy = () => {
      const kind = agentRegistry.get(sessionId)?.phase?.kind
      if (kind && kind !== 'idle') return true
      const session = liveSession(sessionId)
      const events = session ? sessionEvents(session) : []
      const started = events.findLastIndex(event => event?.type === 'turn/start'), ended = events.findLastIndex(event => event?.type === 'turn/end')
      return started > ended
    }
    if (busy()) {
      const agent = agentRegistry.get(sessionId)
      if (once || typeof agent?.whenIdle !== 'function') return null
      await agent.whenIdle()
      if (busy()) return null
    }
    // One reconcile per session at a time; concurrent view reads share it.
    if (reconciling.has(sessionId)) return await reconciling.get(sessionId)
    const run = reconcileStory(sessionId, { stillIdle: () => !busy() })
    reconciling.set(sessionId, run)
    try {
      const report = await run
      if (report) reconciledSessions.add(sessionId)
      return report
    } finally { reconciling.delete(sessionId) }
  }

  function assertBlankStoryForkTarget(sessionId, session) {
    const phase = agentRegistry.get(sessionId)?.phase?.kind
    if (!session || (phase && phase !== 'idle') || session.surface?.nodes?.length || sessionEvents(session).some(event =>
      event.type === 'turn/start' || event.type === 'user/message' || event.type === 'assistant/message')) {
      throw new Error('分叉目标必须是空白 Session')
    }
  }

  // One explicit use only: a story fork starts a fresh native session that
  // carries no context, so its tail is built from the save once, at fork time.
  // Nothing reconciles or repairs a live session behind the player's back.
  async function seedNativeStory(sessionId, session, lastStoryTurn, reason) {
    if (typeof lastStoryTurn === 'string' && reason === undefined) {
      reason = lastStoryTurn
      lastStoryTurn = 0
    }
    const targetLastStoryTurn = Number.isSafeInteger(Number(lastStoryTurn)) && Number(lastStoryTurn) > 0 ? Number(lastStoryTurn) : 0
    const initialChat = await chatForSession(sessionId)
    if (!initialChat || initialChat.regenInProgress || !['story', 'script'].includes(initialChat.mode || 'story')) return null
    const agent = agentRegistry.get(sessionId)
    const beforeLastTurn = agent?.phase?.lastTurn
    const beforeHadLastTurn = Boolean(agent?.phase && Object.hasOwn(agent.phase, 'lastTurn'))
    const SessionClass = session?.constructor
    const beforeEvents = session ? structuredClone(sessionEvents(session)) : []
    const beforeHeader = session?.header ? structuredClone(session.header) : undefined
    const beforeInherited = session?.inheritedEventCount ?? 0
    const beforeNodes = Array.isArray(session?.surface?.nodes) ? [...session.surface.nodes] : null

    function rollbackSessionState() {
      if (!session || typeof session !== 'object') return
      const currentEvents = sessionEvents(session)
      const currentNodes = Array.isArray(session.surface?.nodes) ? session.surface.nodes : []
      const mutated = currentEvents.length !== beforeEvents.length
        || (beforeNodes !== null && currentNodes.length !== beforeNodes.length)
      if (mutated) {
        if (typeof SessionClass?.fromRestore === 'function') {
          const restored = SessionClass.fromRestore(session.id, beforeEvents, beforeHeader, beforeInherited)
          Object.assign(session, restored)
        } else if (Array.isArray(session.events)) {
          session.events.splice(0, session.events.length, ...beforeEvents)
          if (beforeNodes && Array.isArray(session.surface?.nodes)) {
            session.surface.nodes.splice(0, session.surface.nodes.length, ...beforeNodes)
          }
        }
      }
      clearSurfaceEditTurns(session)
      if (agent?.phase) {
        if (beforeHadLastTurn) agent.phase.lastTurn = beforeLastTurn
        else delete agent.phase.lastTurn
      }
    }

    try {
      // The session may have received a turn while the fork save was being written.
      assertBlankStoryForkTarget(sessionId, session)
      let prefixed = false
      if (typeof ensurePrefix === 'function') {
        // 先于开场前缀写入前标记轮次 1 为表面编辑轮，保持开放以便按轮播种首轮复用 turn 1。
        markSurfaceEditTurn(session, 1)
        await ensurePrefix(session, initialChat, { flush: false })
        prefixed = sessionEvents(session).length > beforeEvents.length
      }
      const chat = (await chatForSession(sessionId)) || initialChat
      const repairId = randomUUID()
      if (typeof SessionClass?.fromRestore === 'function') {
        // 先在隔离的 detached 副本上试跑按轮投影，验证全过程无异常后再写入活 Session，避免中途失败留下半成品事件。
        const probe = SessionClass.fromRestore(
          session.id,
          structuredClone(sessionEvents(session)),
          structuredClone(session.header),
          session.inheritedEventCount ?? 0,
          'detached'
        )
        repairNativeSurface(probe, chat, { repairId, perRound: true, seeded: true })
      }
      const result = withSuppressedEditLifecycle(session, () => {
        const applied = repairNativeSurface(session, chat, { repairId, perRound: true, seeded: true })
        releaseOpeningTurn(session, agent)
        return applied
      })
      if (result.applied && targetLastStoryTurn > 0) {
        reserveStoryTurns(session, targetLastStoryTurn, agent)
      }
      // 同步推进 idle Agent 的 lastTurn（不强依赖全局 agentLookup），防止分叉后首条玩家消息撞上刚播种的轮号。
      if (result.applied && agent?.phase?.kind === 'idle') {
        const highestTurn = sessionEvents(session).reduce((highest, event) =>
          event?.type === 'turn/start' ? Math.max(highest, Number(event.data?.turn) || 0) : highest, 0)
        if (highestTurn > 0 || targetLastStoryTurn > 0) {
          agent.phase.lastTurn = Math.max(Number(agent.phase.lastTurn) || 0, highestTurn, targetLastStoryTurn)
        }
      }
      const hasSessionWrites = result.applied || sessionEvents(session).length > beforeEvents.length
      if (hasSessionWrites) await sessionStore.flush(session)
      await updateChat(chat.id, current => recordNativeSurfaceRepair(current, chat, result.anchors) ? current : undefined, { source: 'native-seed' })
      if (result.applied) console.warn('dsh-tavern: 故事分叉建原生上下文（' + reason + '），写入最近 ' + result.plan.rounds.length + ' 轮')
      return { ...result, prefixed }
    } catch (error) {
      rollbackSessionState()
      console.warn('dsh-tavern: 故事分叉建原生上下文失败：' + str(error?.message || error))
      await markNativeStale(initialChat.id, reason).catch(() => {})
      return null
    }
  }

  async function markNativeStale(chatId, reason) {
    await updateChat(chatId, current => {
      if (current.nativeSync?.status === 'stale') return undefined
      current.nativeSync = { status: 'stale', reason: str(reason), at: Date.now() }
      return current
    }, { source: 'native-repair.stale' })
  }

  // The save's latest player rounds, oldest first: enough rows to cover the native window.
  async function storyAlignmentInput(sessionId, nativeCount) {
    const fields = ['id', '_storageRevision', 'mode', 'nativeCommits', 'suppressedDshTurns', 'regeneratedDshTurns', 'regenInProgress', 'nativeSync']
    const head = await chatSliceForSession(sessionId, [], fields)
    let header, rows
    if (head?.chat) {
      const total = Number(head.messageCount) || 0, want = Math.min(total, nativeCount * 3 + 20)
      header = head.chat
      rows = []
      if (want) {
        const selected = await chatSliceForSession(sessionId, Array.from({ length: want }, (_, index) => total - want + index), ['_storageRevision'])
        if (!selected?.chat || selected.chat.id !== header.id || selected.chat._storageRevision !== header._storageRevision) return null
        rows = selected.chat.messages
      }
    } else {
      header = await chatForSession(sessionId)
      rows = header?.messages || []
    }
    if (!header) return null
    const story = rows.filter(message => message?.role === 'assistant' && !message.greeting)
    return { header, rows, storyTurns: story.map(message => Number(message.turn)), storyAnchors: story.map(message => message.nativeAnchor).filter(Boolean) }
  }

  // Turn numbers can agree while the text drifted (an edit that never reached the model):
  // the repair planner checks the latest rounds' text against the rows already read.
  function alignStory(session, input) {
    const report = inspectStoryAlignment({ session, ...input })
    if (report.state === 'regenerating') return report
    const textDrift = planNativeSurfaceRepair({ chat: { id: input.header.id, messages: input.rows }, events: sessionEvents(session), nodes: session.surface?.nodes || [] }).status !== 'intact'
    const nativeSync = input.header.nativeSync?.status || ''
    return { ...report, textDrift, nativeSync, aligned: report.aligned && !textDrift && nativeSync !== 'stale' }
  }

  async function reconcileStory(sessionId, { stillIdle = () => true } = {}) {
    try {
      sessionId = str(sessionId)
      const session = sessionId && liveSession(sessionId)
      if (!session) return null
      const input = await storyAlignmentInput(sessionId, nativeStoryTurns(session).length)
      if (!input || !['story', 'script'].includes(input.header.mode || 'story')) return null
      const report = alignStory(session, input)
      if (report.aligned || report.state === 'regenerating') return report
      for (const round of report.adopt) {
        if (!stillIdle()) return report
        const adopted = await turns.finalize({ sessionId, turn: round.turn, requestId: round.requestId, userText: round.userText, userContent: round.userContent, assistantText: round.assistantText, nativeAnchor: round.nativeAnchor, adopt: true })
        if (adopted?.saved && !adopted.duplicate) console.warn('dsh-tavern: 第 ' + round.turn + ' 轮已完成但未写入存档，已补记')
      }
      if (!stillIdle()) return report
      const shadowed = reshadowRolledBackRounds(session, new Set(report.rolledBackVisible))
      if (shadowed.length) {
        await sessionStore.flush(session)
        console.warn('dsh-tavern: 第 ' + shadowed.join('、') + ' 轮已回退但模型仍能看到，已重新隐藏')
      }
      // No automatic rewrite of the native tail: a drift is reported, never fixed
      // behind the player's back. Only an explicit action (撤回 / 回退 / 重发) changes it.
      let after = report
      if (report.adopt.length || shadowed.length) {
        const updated = await storyAlignmentInput(sessionId, nativeStoryTurns(session).length)
        if (!updated) return null
        after = alignStory(session, updated)
      }
      if (after.state === 'mismatch') console.warn('dsh-tavern: 存档与模型上下文的轮次不一致（不自动修复）：' + JSON.stringify(after.mismatch))
      else if (!after.aligned) console.warn('dsh-tavern: 存档与模型上下文未对齐（不自动修复）：' + (after.nativeSync === 'stale' ? '上次同步失败' : after.textDrift ? '正文不一致' : '找不到原生位置'))
      return after
    } catch (error) {
      console.warn('dsh-tavern: 存档与模型上下文核对失败：' + str(error?.message || error))
      return null
    }
  }

  return {
    reconcileStory,
    reconcileWhenIdle,
    assertBlankStoryForkTarget,
    seedNativeStory,
    // Let a turn start after an in-flight reconcile of its session.
    async waitReconcile(sessionId) { await reconciling.get(str(sessionId))?.catch(() => {}) },
  }
}
