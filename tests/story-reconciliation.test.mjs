import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from './fixtures/dsh-session-host.mjs'
import {
  appendSessionEvent,
  clearSurfaceEditTurns,
  isEditLifecycleSuppressed,
  isSurfaceEditTurn,
  markSurfaceEditTurn,
  sessionEvents,
  withSuppressedEditLifecycle,
} from '../tavern-plugin/lib/domain/session-events.js'
import { createSessionSurfaceMutator } from '../tavern-plugin/lib/domain/session-surface-mutations.js'
import { createStoryReconciliation } from '../tavern-plugin/lib/domain/story-reconciliation.js'
import { registerTurnLifecycleHooks } from '../tavern-plugin/lib/hooks/turn-lifecycle.js'
import { producerSource } from '../tavern-plugin/lib/domain/message-source.js'
import { initializationFixture } from './fixtures/conversation-initialization.mjs'

const reply = (id, turn) => ({ turn, step: 1, message: { id, role: 'assistant', content: [{ type: 'text', text: id }], source: { kind: 'model', provider: 'test', model: 'test' } } })

function harness({ chat, session = Session.create('story'), agent = null } = {}) {
  const reads = [], writes = []
  let saved = structuredClone(chat)
  const service = createStoryReconciliation({
    agentRegistry: new Map(agent ? [['story', agent]] : []),
    sessionStore: new Map([['story', session]]),
    chatForSession: async id => { reads.push(id); return id === 'story' ? structuredClone(saved) : undefined },
    chatSliceForSession: async () => null,
    async updateChat(id, mutate, options) { const next = mutate(structuredClone(saved)); writes.push(options.source); if (next) saved = next; return saved },
    turns: { finalize: async () => assert.fail('nothing to adopt') }
  })
  return { service, session, reads, writes, saved: () => saved }
}

test('concurrent reconciles share one run, and once-only reconciles stop after a report', async () => {
  // A regeneration in progress reports without repairing, so the run needs no native rounds.
  const h = harness({ chat: { id: 'game', mode: 'story', regenInProgress: true, messages: [] } })
  appendSessionEvent(h.session, 'assistant/message', reply('tavern-opening:x', 1), { surfaceOp: 'append' })
  const [first, second] = await Promise.all([h.service.reconcileWhenIdle('story'), h.service.reconcileWhenIdle('story')])
  assert.equal(first.state, 'regenerating')
  assert.equal(second, first, 'the second caller awaits the same run')
  assert.equal(h.reads.length, 1)
  assert.equal(await h.service.reconcileWhenIdle('story', { once: true }), null)
  assert.equal(h.reads.length, 1, 'a session already reconciled is not read again')
  assert.deepEqual(h.writes, [])
})

test('seedNativeStory 为故事分叉按轮初始化独立原生回合，轨迹不再把多轮助手回复合并到第 1 轮', async () => {
  const base = Session.create('story')
  const session = Session.create('story', [], { ...base.header, id: 'story', version: 4 })
  const sessionStore = new Map([['story', session]])
  sessionStore.flush = async () => {}
  const h = harness({
    session,
    chat: {
      id: 'game-fork', mode: 'story',
      nativeSync: { status: 'stale', reason: 'test', at: 1 },
      messages: [
        { role: 'assistant', turn: 1, greeting: true, text: '开场白' },
        { role: 'user', text: '第一句' },
        { role: 'assistant', turn: 2, text: '第一段正文' },
        { role: 'user', text: '第二句' },
        { role: 'assistant', turn: 3, text: '第二段正文' }
      ]
    }
  })
  // harness 的 sessionStore 没有 flush，直接通过 createStoryReconciliation 注入带 flush 的 store。
  let saved = h.saved()
  const service = createStoryReconciliation({
    agentRegistry: new Map(),
    sessionStore,
    chatForSession: async id => id === 'story' ? structuredClone(saved) : undefined,
    chatSliceForSession: async () => null,
    async updateChat(id, mutate) { const next = mutate(structuredClone(saved)); if (next) saved = next; return saved },
    turns: { finalize: async () => assert.fail('nothing to adopt') }
  })

  const result = await service.seedNativeStory('story', session, '故事分叉测试')
  assert.equal(result.applied, true)
  const events = sessionEvents(session)
  assert.deepEqual(events.filter(event => event.type === 'turn/start').map(event => event.data.turn), [1, 2, 3])
  assert.deepEqual(
    events.filter(event => event.type === 'assistant/message').map(event => [event.data.turn, event.data.step, event.data.message.content[0].text]),
    [[1, 1, '开场白'], [2, 1, '第一段正文'], [3, 1, '第二段正文']]
  )
  assert.equal(saved.nativeSync, undefined)
  assert.equal(saved.messages[2].nativeAnchor.turn, 2)
  assert.equal(saved.messages[4].nativeAnchor.turn, 3)
  const alignment = await service.reconcileWhenIdle('story')
  assert.equal(alignment.aligned, true)
})

test('seedNativeStory 预校验副本写入失败时，活 Session 无部分残留污染并标记 stale', async () => {
  const base = Session.create('story')
  const session = Session.create('story', [], { ...base.header, id: 'story', version: 4 })
  let probeCalls = 0
  session.constructor = {
    fromRestore(...args) {
      probeCalls++
      const probe = Session.fromRestore(...args)
      const origAppend = probe.append.bind(probe)
      let turnStarts = 0
      probe.append = (type, ...rest) => {
        if (type === 'turn/start' && ++turnStarts === 2) throw new Error('模拟第 2 轮写入失败')
        return origAppend(type, ...rest)
      }
      return probe
    }
  }
  let liveAppendCalls = 0
  const origLiveAppend = session.append.bind(session)
  session.append = (...args) => { liveAppendCalls++; return origLiveAppend(...args) }

  const beforeEvents = JSON.stringify(sessionEvents(session))
  const beforeNodes = [...session.surface.nodes]
  const sessionStore = new Map([['story', session]])
  sessionStore.flush = async () => {}
  let saved = {
    id: 'game-fork-fail', mode: 'story',
    messages: [
      { role: 'assistant', turn: 1, greeting: true, text: '开场白' },
      { role: 'user', text: '第一句' },
      { role: 'assistant', turn: 2, text: '第一段正文' }
    ]
  }
  const service = createStoryReconciliation({
    agentRegistry: new Map(),
    sessionStore,
    chatForSession: async id => id === 'story' ? structuredClone(saved) : undefined,
    chatSliceForSession: async () => null,
    async updateChat(_id, mutate) { const next = mutate(structuredClone(saved)); if (next) saved = next; return saved },
    turns: { finalize: async () => assert.fail('nothing to adopt') }
  })

  const result = await service.seedNativeStory('story', session, 'probe-fail')
  assert.equal(result, null)
  assert.equal(probeCalls, 1)
  assert.equal(liveAppendCalls, 0)
  assert.equal(JSON.stringify(sessionEvents(session)), beforeEvents)
  assert.deepEqual(session.surface.nodes, beforeNodes)
  assert.equal(saved.nativeSync?.status, 'stale')
  assert.equal(isEditLifecycleSuppressed(session), false)
})

test('seedNativeStory 批量按轮播种期间开启静默编辑抑制标记，完成后立即撤销', async () => {
  const base = Session.create('story')
  const session = Session.create('story', [], { ...base.header, id: 'story', version: 4 })
  const seenStates = []
  const rawAppend = session.append.bind(session)
  session.append = (type, data, ...rest) => {
    if (type === 'turn/start' || type === 'turn/end') {
      seenStates.push([type, data?.turn, isEditLifecycleSuppressed(session)])
    }
    return rawAppend(type, data, ...rest)
  }

  const sessionStore = new Map([['story', session]])
  sessionStore.flush = async () => {}
  let saved = {
    id: 'game-batch', mode: 'story',
    messages: [
      { role: 'assistant', turn: 1, greeting: true, text: '开场白' },
      { role: 'user', text: '输入2' },
      { role: 'assistant', turn: 2, text: '正文2' },
      { role: 'user', text: '输入3' },
      { role: 'assistant', turn: 3, text: '正文3' },
      { role: 'user', text: '输入4' },
      { role: 'assistant', turn: 4, text: '正文4' }
    ]
  }
  const service = createStoryReconciliation({
    agentRegistry: new Map(),
    sessionStore,
    chatForSession: async id => id === 'story' ? structuredClone(saved) : undefined,
    chatSliceForSession: async () => null,
    async updateChat(_id, mutate) { const next = mutate(structuredClone(saved)); if (next) saved = next; return saved },
    turns: { finalize: async () => assert.fail('nothing to adopt') }
  })

  const seeded = await service.seedNativeStory('story', session, 'batch-suppress')
  assert.equal(seeded.applied, true)
  assert.equal(isEditLifecycleSuppressed(session), false)
  assert.equal(seenStates.length, 8)
  assert.ok(seenStates.every(([_type, _turn, suppressed]) => suppressed === true))

  // 普通单次 surface 编辑不置抑制标记，保留原有前景结算生命周期。
  const singleStates = []
  session.append = (type, data, ...rest) => {
    if (type === 'turn/start' || type === 'turn/end') singleStates.push(isEditLifecycleSuppressed(session))
    return rawAppend(type, data, ...rest)
  }
  const mutator = createSessionSurfaceMutator(session, sessionEvents(session))
  mutator.editStep((turn, step) => {
    mutator.append('assistant/message', { turn, step, message: {
      id: 'single-edit', role: 'assistant', content: [{ type: 'text', text: '单次编辑' }],
      source: { kind: 'model', provider: 'dsh-tavern', model: 'native-repair' }
    } }, { surfaceOp: 'append', sourceEventSeqs: [] })
  })
  assert.deepEqual(singleStates, [false, false])
})

test('seedNativeStory 注入 ensurePrefix 且 flush 在写入后失败时完整回滚状态并标记 stale，恢复后重试幂等成功', async () => {
  const base = Session.create('seed-flush-rb-base')
  const session = Session.create('seed-flush-rb', [], { ...base.header, id: 'seed-flush-rb', version: 4 })
  const beforeEvents = structuredClone(sessionEvents(session))
  const agent = { session, phase: { kind: 'idle' } }
  let saved = {
    id: 'chat-flush-rb',
    mode: 'story',
    forkedFrom: { chatId: 'src-chat', round: 2 },
    nativeOpeningAppended: false,
    messages: [
      { role: 'assistant', turn: 1, greeting: true, text: '开场白' },
      { role: 'user', text: '行动2' },
      { role: 'assistant', turn: 2, text: '正文2' }
    ]
  }

  let flushShouldFail = true
  let flushCalls = 0
  const prefixFlushOpts = []
  const mutatorWrite = target => {
    const m = createSessionSurfaceMutator(target, sessionEvents(target))
    m.editStep((turn, step) => {
      m.append('system/message', {
        turn,
        step,
        message: { id: 'sys-prefix', role: 'system', content: [{ type: 'text', text: '固定系统前缀' }], source: producerSource('@deepseek-ai/dsh-system-prompt', undefined, 'system') }
      }, { surfaceOp: 'append' })
    })
  }
  const sessionStore = {
    get: id => (id === session.id ? session : undefined),
    flush: async target => {
      flushCalls++
      if (flushShouldFail) throw new Error('模拟持久化刷盘失败')
      return target
    }
  }
  const rec = createStoryReconciliation({
    agentRegistry: { get: id => (id === session.id ? agent : undefined) },
    sessionStore,
    chatForSession: async () => structuredClone(saved),
    chatSliceForSession: async () => ({ chat: structuredClone(saved), total: saved.messages.length, omitted: 0 }),
    updateChat: async (_id, mutate) => {
      const next = mutate(structuredClone(saved))
      if (next) saved = next
      return saved
    },
    turns: { finalize: async () => {} },
    ensurePrefix: async (target, _chat, opts = {}) => {
      prefixFlushOpts.push(opts.flush)
      if (!sessionEvents(target).some(e => e.type === 'system/message')) mutatorWrite(target)
      return true
    }
  })

  const failedRes = await rec.seedNativeStory(session.id, session, 'flush-fail-test')
  assert.equal(failedRes, null)
  // 回滚验证：ensurePrefix 收到了 { flush: false }，活 Session 全部写入、节点、phase 与编辑态清零，并打上 stale 标记
  assert.deepEqual(prefixFlushOpts, [false])
  assert.equal(flushCalls, 1)
  assert.deepEqual(sessionEvents(session), beforeEvents)
  assert.deepEqual(session.surface.nodes, [])
  assert.equal('lastTurn' in agent.phase, false)
  assert.equal(isEditLifecycleSuppressed(session), false)
  assert.equal(isSurfaceEditTurn(session, 1), false)
  assert.equal(isSurfaceEditTurn(session, 2), false)
  assert.equal(isSurfaceEditTurn(session, 3), false)
  assert.equal(saved.nativeSync?.status, 'stale')

  // 恢复 flush 后重试，应一次性幂等播种成功并清理 stale
  flushShouldFail = false
  const res = await rec.seedNativeStory(session.id, session, 'flush-retry-test')
  assert.equal(res.applied, true)
  assert.equal(res.prefixed, true)
  assert.equal(flushCalls, 2)
  assert.equal(saved.nativeSync, undefined)
  assert.ok(session.surface.nodes.length >= 4)
  assert.doesNotThrow(() => Session.fromRestore(session.id, sessionEvents(session), session.header, 0, 'detached'))
})

test('超过 16 轮 markSurfaceEditTurn 全量保留不截断，withSuppressedEditLifecycle 拒绝 Promise/thenable 且不锁死抑制态', () => {
  const session = Session.create('gt16-and-sync-check')
  const turns = Array.from({ length: 20 }, (_, i) => i + 1)
  withSuppressedEditLifecycle(session, () => {
    for (const t of turns) markSurfaceEditTurn(session, t)
    assert.equal(isEditLifecycleSuppressed(session), true)
  })
  assert.equal(isEditLifecycleSuppressed(session), false)
  for (const t of turns) {
    assert.equal(isSurfaceEditTurn(session, t), true, `轮次 ${t} 的编辑标记不应因超过 16 轮而被截断`)
  }
  clearSurfaceEditTurns(session)
  for (const t of turns) {
    assert.equal(isSurfaceEditTurn(session, t), false)
  }

  assert.throws(() => withSuppressedEditLifecycle(session, 'not-a-fn'), TypeError)
  assert.throws(() => withSuppressedEditLifecycle(session, () => Promise.resolve(1)), TypeError)
  assert.throws(() => withSuppressedEditLifecycle(session, async () => 1), TypeError)
  assert.throws(() => withSuppressedEditLifecycle(session, () => ({ then() {} })), TypeError)
  assert.equal(isEditLifecycleSuppressed(session), false)
})

test('registerTurnLifecycleHooks 在未标 edit 仅 isEditLifecycleSuppressed 为 true 时拦截全套前景副作用，撤销后恢复', async () => {
  const handlers = new Map()
  const session = Session.create('suppress-hook-isolation')
  const calls = { cancel: 0, turnStarted: 0, handoffEnd: 0, flushEdits: 0, completed: 0, reconcile: 0 }

  registerTurnLifecycleHooks({
    ctx: { on: (name, fn) => { handlers.set(name, fn) } },
    flushQueuedBodyEdits: () => { calls.flushEdits++; return Promise.resolve(0) },
    backgroundAgentRunner: { owns: () => false },
    foregroundHandoff: { end: () => { calls.handoffEnd++ } },
    autoChoices: { cancel: () => { calls.cancel++ }, completed: async () => { calls.completed++ } },
    clearRuntimePresetRequestState() {},
    pluginBodyGeneration: {},
    reconcileWhenIdle: async () => { calls.reconcile++ },
    hookChatForSession: async () => null,
    contentText: () => '',
    ensureNativeSystemPrefix: async () => {},
    foregroundStrategies: {},
    nativeWorldBookTemplateContext: async () => ({}),
    persistClearedBodyEdits: async () => {},
    pluginPromptSections: async () => [],
    publishResourceWorkspace: async () => ({}),
    readChatCard: async () => null,
    replaceAssistantReply() {},
    requestIdForTurn: () => '',
    requestPerformance: null,
    runtimePrompt: () => '',
    sessionStore: { flush: async () => {} },
    storyOutputToolCall: async () => null,
    turnOrchestrator: { modeFor: async () => 'story' },
    turnStarted: () => { calls.turnStarted++ },
    userMessageForTurn: () => null,
  })
  const onSessionEvent = handlers.get('session/event')

  // 第 1 轮：故意不调用 markSurfaceEditTurn（edit === false），仅处于 withSuppressedEditLifecycle 抑制窗口内
  withSuppressedEditLifecycle(session, () => {
    appendSessionEvent(session, 'turn/start', { turn: 1 })
    onSessionEvent(session, { type: 'turn/start', seq: 0, data: { turn: 1 } })
    appendSessionEvent(session, 'assistant/message', {
      turn: 1, step: 1,
      message: { id: 'm1', role: 'assistant', content: [{ type: 'text', text: '测试' }], source: { kind: 'model', provider: 'test', model: 'm' } }
    }, { surfaceOp: 'append' })
    appendSessionEvent(session, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    onSessionEvent(session, { type: 'turn/end', seq: 2, data: { turn: 1, reason: { kind: 'completed' } } })
  })
  await new Promise(resolve => setTimeout(resolve, 20))
  assert.deepEqual(calls, { cancel: 0, turnStarted: 0, handoffEnd: 0, flushEdits: 0, completed: 0, reconcile: 0 })

  // 撤销抑制后触发第 2 轮普通对话：所有副作用恢复触发
  appendSessionEvent(session, 'turn/start', { turn: 2 })
  onSessionEvent(session, { type: 'turn/start', seq: 3, data: { turn: 2 } })
  appendSessionEvent(session, 'assistant/message', {
    turn: 2, step: 1,
    message: { id: 'm2', role: 'assistant', content: [{ type: 'text', text: '正常回合' }], source: { kind: 'model', provider: 'test', model: 'm' } }
  }, { surfaceOp: 'append' })
  appendSessionEvent(session, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  onSessionEvent(session, { type: 'turn/end', seq: 5, data: { turn: 2, reason: { kind: 'completed' } } })
  await new Promise(resolve => setTimeout(resolve, 20))

  assert.deepEqual(calls, { cancel: 1, turnStarted: 1, handoffEnd: 1, flushEdits: 1, completed: 1, reconcile: 1 })
})

test('conversation-initialization 对任何 forkedFrom（含空 messages）均无条件早退 appendNativeOpening，且复用外部注入 serialize 锁', async () => {
  const f = initializationFixture()
  const lockCalls = []
  let activeForSession = 0
  let maxConcurrent = 0
  const pending = new Map()
  function externalSerialize(sessionId, work) {
    lockCalls.push(sessionId)
    const key = typeof sessionId === 'string' ? sessionId : ''
    const run = async () => {
      activeForSession++
      maxConcurrent = Math.max(maxConcurrent, activeForSession)
      try { return await work() } finally { activeForSession-- }
    }
    const prev = pending.get(key) || Promise.resolve()
    const next = prev.catch(() => {}).then(run)
    pending.set(key, next)
    return next.finally(() => { if (pending.get(key) === next) pending.delete(key) })
  }

  // 直接用带外部 serialize 的 createConversationInitialization（借助 fixture 的默认组装 + 替换 serialize）
  const { createConversationInitialization } = await import('../tavern-plugin/lib/domain/conversation-initialization.js')
  const { createPlayCardSnapshots } = await import('../tavern-plugin/lib/domain/play-card-snapshots.js')
  const { createStoryTimeline } = await import('../tavern-plugin/lib/domain/story-timeline.js')
  const { createContextPlanner } = await import('../tavern-plugin/lib/domain/context-planner.js')

  let seq = 0
  const snapshots = createPlayCardSnapshots({
    worldBooks: { bound: async () => ({ view: { entries: [] } }) },
    planner: createContextPlanner({ prompt: () => '' }),
    readCard: async () => structuredClone(f.card),
    writeChat: async chat => { f.saved.set(chat.id, structuredClone(chat)) },
  })
  const init = createConversationInitialization({
    serialize: externalSerialize,
    cards: {
      read: async () => structuredClone(f.card),
      readChat: async () => structuredClone(f.card),
      script: async () => undefined,
      extensions: async () => ({}),
      startDefaults: async () => null,
    },
    chats: {
      resolve: f.registry.resolve,
      publish: f.registry.publish,
      write: async (chat, metadata) => { f.trace.push(metadata.source); f.saved.set(chat.id, structuredClone(chat)); return chat },
    },
    snapshots,
    timeline: createStoryTimeline({ id: p => p + '-' + ++seq, now: () => 123 }),
    presets: { fullSnapshot: async () => ({ regexScripts: [] }) },
    settings: async () => ({ compatibilityMode: true }),
    emptyCardWorkspace: () => ({ mountedResources: [], draft: {} }),
    id: p => p + '-' + ++seq,
    now: () => 123,
    native: {
      async wait(id) { f.trace.push('wait:' + id); return { session: f.session(id), agent: { phase: f.session(id).phase } } },
      async ensurePrefix(target, text) { f.trace.push('prefix:' + target.id); target.prefix ||= text },
      async flush(target) { f.trace.push('flush:' + target.id); target.durable = structuredClone(target.events) },
      async ensureCardWorkspace() {},
      async selectModel() {},
      selection: () => ({ provider: 'fixture', model: 'text' }),
    },
    present: async chat => chat,
    logger: { warn() {} },
  })

  // 场景 A：空 messages: [] 但带有 forkedFrom 的分叉聊天 -> ensureOpening 不得写开场或 prefix/flush
  const forkEmptySessionId = 'fork-empty-s'
  const forkEmptyChat = { id: 'fork-empty-c', sessionId: forkEmptySessionId, cardPath: f.card.path, mode: 'story', forkedFrom: { chatId: 'src', round: 0 }, messages: [] }
  await f.registry.publish(forkEmptyChat)
  await init.ensureOpening(forkEmptySessionId)
  assert.deepEqual(f.session(forkEmptySessionId).events, [])
  assert.equal(f.saved.get(forkEmptyChat.id)?.nativeOpeningAppended, undefined)
  assert.equal(f.trace.some(item => item.endsWith(forkEmptySessionId)), false)

  // 场景 B：带消息体的 forkedFrom 分叉 -> 同理无条件早退
  const forkMsgSessionId = 'fork-msg-s'
  const forkMsgChat = { id: 'fork-msg-c', sessionId: forkMsgSessionId, cardPath: f.card.path, mode: 'story', forkedFrom: { chatId: 'src', round: 1 }, messages: [{ role: 'assistant', turn: 1, greeting: true, text: '开场' }] }
  await f.registry.publish(forkMsgChat)
  await init.ensureOpening(forkMsgSessionId)
  assert.deepEqual(f.session(forkMsgSessionId).events, [])
  assert.equal(f.saved.get(forkMsgChat.id)?.nativeOpeningAppended, undefined)

  // 场景 C：并发调用普通会话初始化，验证通过同一个外部注入 serialize 严格串行化
  const normalSid = 'normal-serialized-s'
  await Promise.all([
    init.start({ cardPath: f.card.path, sessionId: normalSid, mode: 'play', userName: '玩家' }),
    init.ensureOpening(normalSid),
  ])
  assert.ok(lockCalls.includes(forkEmptySessionId))
  assert.ok(lockCalls.includes(forkMsgSessionId))
  assert.ok(lockCalls.filter(id => id === normalSid).length >= 2)
  assert.equal(maxConcurrent, 1)
})

test('编辑投影回合后紧跟新玩家轮与失败清理时，inputEventForTurn 与 uncommittedRounds 不跨轮窃取输入伪造假轮', async () => {
  const { inputEventForTurn } = await import('../tavern-plugin/lib/domain/session-turn-input.js')
  const { uncommittedRounds } = await import('../tavern-plugin/lib/domain/uncommitted-rounds.js')
  const { clearFailedTurnSurface } = await import('../tavern-plugin/lib/domain/rollback-surface.js')
  const { roundAnchor } = await import('../tavern-plugin/lib/domain/round-anchor.js')
  const session = Session.create('story')
  const model = { kind: 'model', provider: 'fixture', model: 'fixture' }
  const text = value => [{ type: 'text', text: value }]

  // Turn 1 开场 + Turn 21 玩家轮
  appendSessionEvent(session, 'turn/start', { turn: 21 })
  appendSessionEvent(session, 'step/start', { turn: 21, step: 1 })
  const u21 = appendSessionEvent(session, 'user/message', { id: 'u21', role: 'user', content: text('行动21'), source: { kind: 'user', rpcId: 'rpc-21' } }, { surfaceOp: 'append' })
  const a21 = appendSessionEvent(session, 'assistant/message', { turn: 21, step: 1, message: { id: 'a21', role: 'assistant', content: text('原正文21'), source: model } }, { surfaceOp: 'append' })
  appendSessionEvent(session, 'step/end', { turn: 21, step: 1 })
  appendSessionEvent(session, 'turn/end', { turn: 21, reason: { kind: 'completed' } })

  // Turn 22 重摇尝试 + Turn 23 编辑投影替换 Turn 21 的回复
  appendSessionEvent(session, 'turn/start', { turn: 22 })
  appendSessionEvent(session, 'step/start', { turn: 22, step: 1 })
  const r22 = appendSessionEvent(session, 'user/message', { id: 'r22', role: 'user', content: [], source: { kind: 'plugin:dsh-tavern-regen', regenerationId: 'rg-22' } }, { surfaceOp: 'append' })
  const a22 = appendSessionEvent(session, 'assistant/message', { turn: 22, step: 1, message: { id: 'a22', role: 'assistant', content: text('清晨八点半的阳光...'), source: model } }, { surfaceOp: 'append' })
  appendSessionEvent(session, 'step/end', { turn: 22, step: 1 })
  appendSessionEvent(session, 'turn/end', { turn: 22, reason: { kind: 'completed' } })

  appendSessionEvent(session, 'turn/start', { turn: 23 })
  appendSessionEvent(session, 'step/start', { turn: 23, step: 1 })
  const a23 = appendSessionEvent(session, 'assistant/message', {
    turn: 23, step: 1,
    message: { id: 'tavern-regen:7c0172a1', role: 'assistant', content: text('清晨八点半的阳光...'), source: { ...model, tavernStoryTurn: 21 } }
  }, { surfaceOp: { op: 'replace', startSeq: a21.seq, endSeq: a22.seq }, sourceEventSeqs: [a21.seq, r22.seq, a22.seq] })
  appendSessionEvent(session, 'step/end', { turn: 23, step: 1 })
  appendSessionEvent(session, 'turn/end', { turn: 23, reason: { kind: 'completed' } })

  // 紧跟 Turn 24 玩家输入“继续”，随后失败清理
  appendSessionEvent(session, 'turn/start', { turn: 24 })
  appendSessionEvent(session, 'step/start', { turn: 24, step: 1 })
  appendSessionEvent(session, 'user/message', { id: 'u24', role: 'user', content: text('继续'), source: { kind: 'user', rpcId: 'rpc-24' } }, { surfaceOp: 'append' })
  appendSessionEvent(session, 'step/end', { turn: 24, step: 1 })
  appendSessionEvent(session, 'turn/end', { turn: 24, reason: { kind: 'error', message: 'TRANSPORT' } })
  clearFailedTurnSurface({ session, turn: 24 })

  const chat = {
    id: 'game', mode: 'story',
    regeneratedDshTurns: { '21': 22 },
    suppressedDshTurns: [22],
    nativeCommits: { '21': { seq: a23.seq } },
    messages: [
      { role: 'user', text: '行动21' },
      { role: 'assistant', turn: 21, text: '清晨八点半的阳光...', nativeAnchor: roundAnchor(21, u21, a21) }
    ]
  }

  assert.equal(inputEventForTurn(session, 23), null, 'Turn 23 自身没有输入，绝不越界窃取 Turn 24 的输入')
  assert.deepEqual(uncommittedRounds(session, chat), [], '编辑投影回合 23 不得借用后续输入与他人投影伪造成未提交轮')

  const h = harness({ session, chat })
  await h.service.reconcileWhenIdle('story')
  assert.equal(h.saved().messages.length, 2, '闲置核对不得向存档补写假轮')
})
