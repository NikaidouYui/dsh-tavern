import assert from 'node:assert/strict'
import test from 'node:test'

import { createForegroundHandoff } from '../tavern-plugin/lib/domain/foreground-handoff.js'
import { Session } from './fixtures/dsh-session-host.mjs'
import { appendSessionEvent, sessionEvents, openTurnStep } from '../tavern-plugin/lib/domain/session-events.js'
import { createStoryTimeline } from '../tavern-plugin/lib/domain/story-timeline.js'
import { createRoundHistory } from '../tavern-plugin/lib/domain/round-history.js'
import { registerTurnLifecycleHooks } from '../tavern-plugin/lib/hooks/turn-lifecycle.js'
import { registerRequestHooks } from '../tavern-plugin/lib/hooks/request.js'
import { prepareWorldBookRecall } from '../tavern-plugin/lib/domain/worldbook-recall.js'
import { createBackgroundProgress } from '../tavern-plugin/lib/domain/background-progress.js'
import { createSettlementJobs } from '../tavern-plugin/lib/domain/settlement-jobs.js'

test('sending during a silent settlement waits for its failure receipt, then starts the next body without a retry', async t => {
  t.mock.timers.enable({apis:['setTimeout','Date']})
  const chat={id:'waiting',settleStatus:'running',variables:{location:'last-confirmed'}}
  let executions=0,prepared=0,cancelled=0
  const jobs=createSettlementJobs({async run(){
    executions++
    const progress=createBackgroundProgress({onCancel:()=>cancelled++})
    progress.frame({type:'start',attemptId:'settlement'})
    try {await progress.wait(new Promise(()=>{}))}
    catch(error){chat.settleStatus='failed';chat.settleError=error.message}
    finally{progress.dispose()}
  },async onSettled(){}})
  t.after(()=>jobs.dispose())
  const previous=jobs.start(chat.id)
  const handoff=createForegroundHandoff({store:{async chatForSession(){return chat}},
    tasks:{activity(){return {role:'settlement',phase:chat.settleStatus,busy:true}}},
    // the tasks the next turn waits for (upstream workflow.beforeNextTurn: settlement, plugin tasks).
    queueBackground:id=>jobs.start(id),beforeNextTurn:chat=>jobs.pending(chat.id),
    turns:{async finalize(){},async discard(){},async prepare(){
      assert.equal(chat.settleStatus,'failed');assert.match(chat.settleError,/90 秒/)
      assert.deepEqual(chat.variables,{location:'last-confirmed'});prepared++
    }}
  })
  const next=handoff.prepare({sessionId:'s',turn:10,userText:'前往医院'})
  await new Promise(resolve=>setImmediate(resolve))
  t.mock.timers.tick(89999)
  assert.equal(prepared,0)
  t.mock.timers.tick(1)
  await Promise.all([previous,next])
  assert.equal(executions,1);assert.equal(cancelled,1);assert.equal(prepared,1)
})

test('候选重生成跳过普通下一回合的世界同步与失败清理', async () => {
  const order = []
  const handoff = createForegroundHandoff({
    store: { async chatForSession() { return { id: 'chat', mode: 'story', messages: [{ role: 'assistant', text: '旧正文' }],
      regenInProgress: true, regenRecovery: { candidateFrame: { kind: 'foreground' } } } } },
    tasks: { activity() { throw new Error('候选准备不得读取普通任务状态') } },
    async queueBackground() {},
    async beforeNextTurn() { order.push('beforeNextTurn') },
    async clearFailedTurns() { order.push('clearFailedTurns') },
    async syncWorldBook() { order.push('syncWorldBook') },
    turns: { async finalize() {}, async discard() {}, async prepare() { order.push('prepare'); return { ready: true } } }
  })
  const prepared = await handoff.prepare({ sessionId: 'session', turn: 3, userText: '继续' })
  assert.equal(prepared.ready, true)
  assert.deepEqual(order, ['prepare'])
})

test('a turn that ends in an error records why on its kept input before the discard', async () => {
  const order = []
  const handoff = createForegroundHandoff({
    store: { async chatForSession() { return { id: 'chat' } } },
    tasks: { activity() { return {} } }, async queueBackground() {},
    defer: work => work(),
    turns: { async finalize() {}, async prepare() {},
      async recordFailure(input) { order.push(['failure', input]) },
      async discard(target) { order.push(['discard', target]) } }
  })
  handoff.end({ sessionId: 's', turn: 4, reason: 'error', error: { code: 'BAD_REQUEST', message: 'API error (400): invalid thinking signature' } })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(order, [
    ['failure', { sessionId: 's', turn: 4, code: 'BAD_REQUEST', message: '这一轮没有生成正文：API error (400): invalid thinking signature' }],
    ['discard', { sessionId: 's', turn: 4 }]
  ])
  // A stop by the player is not a failure.
  order.length = 0
  handoff.end({ sessionId: 's', turn: 5, reason: 'aborted' })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(order, [['discard', { sessionId: 's', turn: 5 }]])
})

test('awaitOpening waits for the card scripts only while the MVU opening is pending', async () => {
  let status = 'pending', waited = 0
  const handoff = createForegroundHandoff({
    store: { async chatForSession() { return { mvu: { enabled: true, owner: 'official', openingInitialization: { status } } } } },
    scriptDispatch: { async waitUntilReady(id) { assert.equal(id, 's'); waited++ } },
    tasks: { activity() { return {} } }, async queueBackground() {},
    turns: { async finalize() {}, async prepare() {}, async discard() {} }
  })
  await handoff.awaitOpening('s')
  status = 'complete'
  await handoff.awaitOpening('s')
  assert.equal(waited, 1)
})

test('正文准备冲突在 DSH 转为 UNKNOWN 前保存原始错误码和请求号', async () => {
  const conflict = { reason: 'header-changed', revision: 7, currentRevision: 8, field: 'timeline' }
  const error = Object.assign(new Error('存档在准备正文期间发生冲突，本轮已停止'), { code: 'TAVERN_PREPARE_CONFLICT', conflict })
  const input = { sessionId: 's', turn: 4, requestId: 'req-4', userText: '继续' }
  const logs = []
  let failure
  const handoff = createForegroundHandoff({
    store: { async chatForSession() { return { id: 'chat' } } },
    tasks: { activity() { return {} } }, async queueBackground() {},
    logger: { warn: message => logs.push(message) },
    turns: {
      async finalize() {}, async discard() {}, async prepare() { throw error },
      async recordFailure(next) { failure = next }
    }
  })
  await assert.rejects(handoff.prepare(input), caught => caught === error)
  assert.deepEqual(failure, { sessionId: 's', turn: 4, requestId: 'req-4', code: error.code,
    message: '这一轮没有生成正文：' + error.message })
  assert.deepEqual(logs, ['dsh-tavern: 正文准备冲突 ' + JSON.stringify({ sessionId: 's', turn: 4, code: error.code, ...conflict })])
})

function createFailedRegenHandoffHarness() {
  const model = { kind: 'model', provider: 'fixture', model: 'fixture' }
  const session = Session.create('handoff-abandon-' + Math.random().toString(36).slice(2))
  let idCounter = 0
  const timeline = createStoryTimeline({ id: prefix => prefix + '-' + (++idCounter), now: () => 3000 })
  const revisions = new Map()
  const snapshotRevision = snapshot => {
    if (snapshot?._storageRevision) revisions.set(snapshot._storageRevision, structuredClone(snapshot))
  }
  let chat = {
    id: 'chat', sessionId: session.id, mode: 'story', _storageRevision: 1,
    tavernHelperLifecycleRevision: 1,
    messages: [{ role: 'assistant', greeting: true, text: '开场白', turn: 1 }],
    posture: '安全屋', variables: { poison: false }, nativeCommits: {}, userInputEdits: {}
  }
  snapshotRevision(chat)

  // Turn 2 正常提交（并写入毒化状态用于检测后续是否残留）
  appendSessionEvent(session, 'turn/start', { turn: 2 })
  const in2 = appendSessionEvent(session, 'user/message', {
    id: 'in-2', role: 'user', content: [{ type: 'text', text: '旧回合输入' }], source: { kind: 'user', rpcId: 'rpc-2' }
  }, { surfaceOp: 'append' })
  appendSessionEvent(session, 'step/start', { turn: 2, step: 1 })
  const out2 = appendSessionEvent(session, 'assistant/message', {
    turn: 2, step: 1, message: { id: 'out-2', role: 'assistant', content: [{ type: 'text', text: '被撤销的旧剧情正文' }], source: model }
  }, { surfaceOp: 'append', sourceEventSeqs: [] })
  appendSessionEvent(session, 'step/end', { turn: 2, step: 1 })
  appendSessionEvent(session, 'turn/end', { turn: 2, reason: { kind: 'completed' } })

  const begun2 = timeline.apply({ chat, intent: { kind: 'body.begin', turn: 2, userText: '旧回合输入' } })
  chat = timeline.complete({
    chat: begun2.chat, operationId: begun2.value.operationId, basedOn: begun2.value.basedOn,
    outcome: { status: 'success' },
    apply(draft) {
      draft.messages.push(
        { role: 'user', turn: 2, text: '旧回合输入', native: true, source: { kind: 'user', rpcId: 'rpc-2' } },
        { role: 'assistant', turn: 2, text: '被撤销的旧剧情正文', variables: [{ poison: true }],
          nativeAnchor: { formatVersion: 4, turn: 2, input: in2.seq, reply: out2.seq } }
      )
      draft.posture = '危险区'
      draft.variables = { poison: true }
      draft.nativeCommits['2'] = { turn: 2, userText: '旧回合输入' }
    }
  }).chat
  chat._storageRevision = (chat._storageRevision || 1) + 1
  snapshotRevision(chat)

  // Turn 2 重生成失败：messages 移除旧正文保留 failedRegenerationTarget；并落盘新输入 placeholder
  const discardedAssistant = chat.messages.pop()
  chat.failedRegenerationTarget = { assistantIndex: 2, inputIndex: 1, assistant: discardedAssistant, dshTurn: 2 }
  chat.replacingDshTurns = [2]
  chat.messages.push({ role: 'user', text: '全新的下一步行动', native: true, placeholder: true, source: { kind: 'user', rpcId: 'rpc-4' } })
  chat._storageRevision += 1
  snapshotRevision(chat)

  const agent = { session, phase: { kind: 'running' } }
  const chats = {
    read: async () => structuredClone(chat),
    forSession: async () => structuredClone(chat),
    readRevision: async (_id, rev) => (revisions.has(rev) ? structuredClone(revisions.get(rev)) : undefined),
    readCard: async () => ({ name: '角色' }),
    update: async (_id, mutate) => {
      const next = await mutate(structuredClone(chat))
      if (next !== undefined) {
        next._storageRevision = (chat._storageRevision || 1) + 1
        chat = structuredClone(next)
        snapshotRevision(chat)
      }
      return structuredClone(chat)
    }
  }
  const rounds = createRoundHistory({
    chats,
    timeline,
    scripts: {},
    sessions: { get: () => agent, flush: async () => {} }
  })

  const handoff = createForegroundHandoff({
    turns: {
      async prepare(input) { return { ready: true, turn: input.turn } },
      async finalize() {},
      async discard() {}
    },
    store: {
      chatForSession: async () => structuredClone(chat),
      readChat: async () => structuredClone(chat),
      stateForSession: async () => structuredClone(chat),
      openingStateForSession: async () => null
    },
    tasks: { activity: () => ({ busy: false }) },
    async queueBackground() {},
    async beforeNextTurn() {},
    clearFailedTurns: async id => rounds.abandonFailedRegeneration(id),
    async syncWorldBook() {}
  })

  const handlers = new Map()
  const ctx = { on(name, fn) { handlers.set(name, fn) } }
  const seenInWorldBook = []
  const seenInPrepareStep = []
  const seenInCardMemory = []

  registerTurnLifecycleHooks({
    ctx,
    foregroundHandoff: handoff,
    foregroundStrategies: {
      assembleSystemPrompt(value) { return value || { sections: [] } }
    },
    backgroundAgentRunner: { owns: () => false },
    hookChatForSession: async () => structuredClone(chat),
    contentText: () => '',
    ensureNativeSystemPrefix: async () => {},
    nativeWorldBookTemplateContext: async current => { seenInWorldBook.push(structuredClone(current)); return {} },
    pluginPromptSections: async () => [],
    publishResourceWorkspace: async () => null,
    readChatCard: async () => ({}),
    replaceAssistantReply() {},
    requestIdForTurn: () => '',
    runtimePrompt: () => '',
    sessionStore: { get: () => session, flush: async () => {} },
    storyOutputToolCall: async () => null,
    turnOrchestrator: { modeFor: async () => 'story' },
    turnStarted() {},
    userMessageForTurn: () => null,
    autoChoices: { cancel() {}, completed: async () => {} },
    clearRuntimePresetRequestState() {},
    pluginBodyGeneration: {},
    reconcileWhenIdle: async () => {},
    flushQueuedBodyEdits: async () => 0,
    persistClearedBodyEdits: async () => {}
  })
  registerRequestHooks({
    ctx,
    foregroundHandoff: handoff,
    foregroundStrategies: {
      prepareStep({ chat: stepChat, decision }) {
        seenInPrepareStep.push(structuredClone(stepChat))
        return decision
      }
    },
    backgroundAgentRunner: { owns: () => false },
    chatForSession: async () => structuredClone(chat),
    sessionStore: { get: () => session },
    cardMemory: {
      appendRecall({ chat: memChat, decision }) {
        seenInCardMemory.push(structuredClone(memChat))
        return decision
      }
    },
    requestIdForMessages: () => '',
    tavernRetryLimiter: { handle() {} }
  })

  return {
    model, session, agent, rounds, handoff, handlers,
    seenInWorldBook, seenInPrepareStep, seenInCardMemory,
    getChat: () => chat,
    setRegenInProgress(enabled) {
      if (enabled) chat.regenInProgress = true
      else delete chat.regenInProgress
    }
  }
}

test('重生成失败后直接发新消息：在 system-prompt/assemble 与 pre-step 前自动放弃旧轮次并回滚上下文，regenInProgress 时绝不误触', async () => {
  const harness = createFailedRegenHandoffHarness()
  const { model, session, agent, rounds, handoff, handlers, seenInWorldBook, seenInPrepareStep, seenInCardMemory } = harness

  // 先验证 regenInProgress: true 时绝不误触 abandonFailedRegeneration
  harness.setRegenInProgress(true)
  assert.equal(await rounds.abandonFailedRegeneration(session.id), 0)
  assert.ok(harness.getChat().failedRegenerationTarget, '重生成进行中时保留 failedRegenerationTarget')
  harness.setRegenInProgress(false)

  // DSH 真实进入第 4 轮：先开 turn/start，再依次触发 system-prompt/assemble 与 agent/pre-step (step=1)
  appendSessionEvent(session, 'turn/start', { turn: 4 })
  await handlers.get('system-prompt/assemble')(
    {},
    { agent, turn: 4, userMessage: { content: [{ type: 'text', text: '全新的下一步行动' }] } },
    async () => ({})
  )
  await handlers.get('agent/pre-step')(
    { agent, turn: 4, step: 1, messages: [] },
    async () => {
      await handoff.prepare({ sessionId: session.id, turn: 4, userText: '全新的下一步行动' })
      return { action: 'model' }
    }
  )

  assert.equal(seenInWorldBook.length, 1)
  assert.equal(seenInWorldBook[0].variables?.poison, false, 'worldbook 组装阶段必须已回滚失败重生成轮的变量')
  assert.equal(seenInWorldBook[0].posture, '安全屋')
  assert.equal(seenInPrepareStep.length, 1)
  assert.equal(seenInPrepareStep[0].variables?.poison, false, 'pre-step 读取必须看到回滚后的状态')
  assert.equal(seenInCardMemory.length, 1)
  assert.equal(seenInCardMemory[0].posture, '安全屋', 'cardMemory 召回必须读取回滚后的最新 chat')
  assert.equal(harness.getChat().failedRegenerationTarget, undefined)
  assert.deepEqual(harness.getChat().messages.map(m => m.text), ['开场白', '全新的下一步行动'])
  assert.deepEqual(openTurnStep(sessionEvents(session)), { turn: 4, step: null })

  // 完成本轮原生落盘并通过 fromRestore 重放验证不含旧轮内容
  appendSessionEvent(session, 'step/start', { turn: 4, step: 1 })
  appendSessionEvent(session, 'user/message', {
    id: 'in-4', role: 'user', content: [{ type: 'text', text: '全新的下一步行动' }], source: { kind: 'user', rpcId: 'rpc-4' }
  }, { surfaceOp: 'append' })
  appendSessionEvent(session, 'assistant/message', {
    turn: 4, step: 1, message: { id: 'out-4', role: 'assistant', content: [{ type: 'text', text: '第4轮正确新正文' }], source: model }
  }, { surfaceOp: 'append', sourceEventSeqs: [] })
  appendSessionEvent(session, 'step/end', { turn: 4, step: 1 })
  appendSessionEvent(session, 'turn/end', { turn: 4, reason: { kind: 'completed' } })

  const events = sessionEvents(session)
  const reopened = Session.fromRestore(session.id, events, session.header, 0, 'detached')
  const derived = JSON.stringify(reopened.deriveMessages())
  assert.match(derived, /全新的下一步行动/)
  assert.match(derived, /第4轮正确新正文/)
  assert.doesNotMatch(derived, /旧回合输入|被撤销的旧剧情正文/)
})

test('跳过 system-prompt/assemble 仅触发 agent/pre-step(step=1) 仍放弃旧轮次；regenInProgress 时两类 hook 都不误清理', async () => {
  const harness = createFailedRegenHandoffHarness()
  const { session, agent, handoff, handlers, seenInWorldBook, seenInPrepareStep, seenInCardMemory } = harness

  harness.setRegenInProgress(true)
  appendSessionEvent(session, 'turn/start', { turn: 3 })
  await handlers.get('system-prompt/assemble')(
    {},
    { agent, turn: 3, userMessage: { content: [{ type: 'text', text: '旧回合输入' }] } },
    async () => ({})
  )
  await handlers.get('agent/pre-step')(
    { agent, turn: 3, step: 1, messages: [] },
    async () => ({ action: 'model' })
  )
  assert.equal(seenInWorldBook.at(-1)?.variables?.poison, true, '重生成进行中 assemble hook 不得回滚状态')
  assert.equal(seenInPrepareStep.at(-1)?.variables?.poison, true, '重生成进行中 pre-step hook 不得回滚状态')
  assert.ok(harness.getChat().failedRegenerationTarget)

  // 关闭重生成标志并模拟跳过 system-prompt/assemble，直接进入第 4 轮 agent/pre-step (step=1)
  harness.setRegenInProgress(false)
  appendSessionEvent(session, 'turn/start', { turn: 4 })
  await handlers.get('agent/pre-step')(
    { agent, turn: 4, step: 1, messages: [] },
    async () => {
      await handoff.prepare({ sessionId: session.id, turn: 4, userText: '全新的下一步行动' })
      return { action: 'model' }
    }
  )

  assert.equal(seenInPrepareStep.at(-1)?.variables?.poison, false, '仅经 agent/pre-step(step=1) 触发时也应回滚旧变量')
  assert.equal(seenInCardMemory.at(-1)?.posture, '安全屋', '仅经 agent/pre-step(step=1) 触发时 cardMemory 应看到回滚后的状态')
  assert.equal(harness.getChat().failedRegenerationTarget, undefined)
  assert.deepEqual(harness.getChat().messages.map(m => m.text), ['开场白', '全新的下一步行动'])
  assert.deepEqual(openTurnStep(sessionEvents(session)), { turn: 4, step: null })
})
