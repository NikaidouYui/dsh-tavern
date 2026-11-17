import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { assertConversationForkable } from '../tavern-plugin/lib/domain/conversation-fork.js'
import vm from './fixtures/client-vm.mjs'
import { sourceFunction } from './fixtures/source-function.mjs'

function sourceChat() {
  return {
    id: 'chat-source', sessionId: 'session-source', cardPath: 'cards/a.json', cardName: '阿青', mode: 'story',
    _storageRevision: 17, createdAt: 1, updatedAt: 2, settleStatus: 'done', settleError: null,
    messages: [
      { role: 'assistant', greeting: true, turn: 1, text: '开场' },
      { role: 'user', text: '进门' },
      { role: 'assistant', turn: 2, text: '她抬起头。', variables: [{ hp: 9 }] }
    ],
    posture: '门内', worldBookReads: { gate: 2 }, tavernPluginData: { phone: { chats: ['保留'] } },
    candidates: { items: ['旧候选'] }, candidateAgent: { sessionId: 'background-old' },
    nativeCommits: { 2: { old: true } }, suppressedDshTurns: [9], regeneratedDshTurns: { 2: 9 },
    timeline: {
      schemaVersion: 1, branchId: 'branch-source', revision: 4,
      checkpoints: [{ id: 'checkpoint-4', beforeRevision: 12 }],
      participants: { background: { sessionId: 'background-old', lifetime: 'chat' } },
      operations: { completed: { id: 'completed', kind: 'body', status: 'completed' } }
    }
  }
}

test('分叉只接受没有前台或后台未完成工作的游玩对话', () => {
  assert.equal(assertConversationForkable(sourceChat()), true)
  assert.throws(() => assertConversationForkable({ ...sourceChat(), mode: 'card' }), /只有游玩对话/)
  assert.throws(() => assertConversationForkable(sourceChat(), { agentRunning: true }), /正文仍在生成/)
  const settling = sourceChat()
  settling.timeline.operations.running = { kind: 'body', status: 'completed', background: { phase: 'pending' } }
  assert.throws(() => assertConversationForkable(settling), /状态结算/)
  assert.throws(() => assertConversationForkable({
    ...sourceChat(),
    mvu: { enabled: true, openingInitialization: { status: 'pending' } }
  }), /MVU 开局状态尚未初始化完成/)
  const dangling = sourceChat()
  dangling.messages.push({ role: 'user', text: '未完成' })
  assert.throws(() => assertConversationForkable(dangling), /尚未产生正文/)
})

test('分叉只保留分叉点及之前的隐藏轮次记录：分叉后续用的原生轮号不会把新回复整轮隐藏', async () => {
  const { forkConversationChat } = await import('../tavern-plugin/lib/domain/conversation-fork.js')
  const { foregroundSuppressedTurns } = await import('../tavern-plugin/lib/domain/rollback-surface.js')
  // Native turns 1–3 existed; turn 3 was rolled back, an aborted regeneration left 5,
  // and turn 2 was regenerated into synthetic turn 4.
  const source = { ...sourceChat(), suppressedDshTurns: [3, 4, 5], hiddenDshErrorTurns: [2, 5], regeneratedDshTurns: { 2: 4, 3: 5 } }
  const fork = forkConversationChat(source, { chatId: 'chat-fork', sessionId: 'session-fork', id: prefix => prefix + '-x', lastNativeTurn: 4 })
  assert.deepEqual(fork.suppressedDshTurns, [3, 4])
  assert.deepEqual(fork.hiddenDshErrorTurns, [2])
  assert.deepEqual(fork.regeneratedDshTurns, { 2: 4 })
  assert.deepEqual(source.suppressedDshTurns, [3, 4, 5], 'the source game is untouched')
  let seq = 0
  const event = (type, data) => ({ seq: seq++, type, data })
  const reply = turn => event('assistant/message', { turn, message: { role: 'assistant', source: { kind: 'model' }, content: [{ type: 'text', text: 'NEW' }] } })
  const events = [5].flatMap(turn => [event('turn/start', { turn }), reply(turn), event('turn/end', { turn, reason: { kind: 'completed' } })])
  assert.equal(foregroundSuppressedTurns(fork, events).includes(5), false, 'the fork\'s next native turn 5 shows its reply')
  const unpruned = forkConversationChat(source, { chatId: 'chat-old', sessionId: 'session-old', id: prefix => prefix + '-x' })
  assert.equal(foregroundSuppressedTurns(unpruned, events).includes(5), true, 'without the fork point the stale entry would hide it')
})

test('分叉来源带着故事消息序号，原生轮号分叉不带', async () => {
  const { forkConversationChat } = await import('../tavern-plugin/lib/domain/conversation-fork.js')
  const fork = forkConversationChat(sourceChat(), { chatId: 'chat-message', sessionId: 'session-message', id: prefix => prefix + '-x', messageIndex: 2 })
  assert.equal(fork.forkedFrom.messageIndex, 2)
  assert.equal(fork.forkedFrom.chatId, 'chat-source')
  const native = forkConversationChat(sourceChat(), { chatId: 'chat-native', sessionId: 'session-native', id: prefix => prefix + '-x', lastNativeTurn: 2 })
  assert.equal(native.forkedFrom.messageIndex, undefined)
})

test('复制完整会话保留有效原生提交映射、同步标记与副本溯源，并清理独占后台/撤销字段', async () => {
  const { forkConversationChat, assertConversationForkable } = await import('../tavern-plugin/lib/domain/conversation-fork.js')
  const source = {
    ...sourceChat(),
    rollbackUndo: { version: 1, id: 'undo-1', turn: 2 },
    backgroundSessionId: 'bg-source',
    backgroundHistoryIds: ['bg-hist-1'],
    importHistory: { version: 1, operationId: 'op-import-1' },
    backgroundTasks: [{ id: 'task-1' }],
    nativeOpeningAppended: true,
    nativeSync: { status: 'synced', at: 100 },
    nativeCommits: {
      1: { turn: 1, operationId: 'op-1' },
      2: { turn: 2, operationId: 'op-2' },
      3: { turn: 3, operationId: 'op-stale' }
    }
  }
  const duplicated = forkConversationChat(source, {
    chatId: 'chat-dup',
    sessionId: 'session-dup',
    id: prefix => prefix + '-dup',
    lastNativeTurn: 2,
    duplicate: true,
    preserveNativeCommits: true,
    preserveNativeSync: true,
    turn: 2,
    atSeq: 19
  })
  assert.deepEqual(duplicated.nativeCommits, {
    1: { turn: 1, operationId: 'op-1' },
    2: { turn: 2, operationId: 'op-2' }
  })
  assert.equal(duplicated.nativeOpeningAppended, true)
  assert.deepEqual(duplicated.nativeSync, { status: 'synced', at: 100 })
  assert.equal(duplicated.forkedFrom.kind, 'duplicate')
  assert.equal(duplicated.forkedFrom.turn, 2)
  assert.equal(duplicated.forkedFrom.atSeq, 19)
  assert.equal(duplicated.rollbackUndo, undefined)
  assert.equal(duplicated.backgroundSessionId, undefined)
  assert.equal(duplicated.backgroundHistoryIds, undefined)
  assert.equal(duplicated.importHistory, undefined)
  assert.equal(duplicated.backgroundTasks, undefined)

  // 原有分支同样不得继承源会话的后台、导入与撤销所有权。
  const partialFork = forkConversationChat(source, { chatId: 'chat-part', sessionId: 'session-part', id: prefix => prefix + '-part', lastNativeTurn: 2 })
  assert.deepEqual(partialFork.nativeCommits, {})
  assert.equal(partialFork.rollbackUndo, undefined)
  assert.equal(partialFork.backgroundSessionId, undefined)
  assert.equal(partialFork.forkedFrom.kind, undefined)

  // assertConversationForkable 在 duplicate: true 下给出「复制」语义报错且禁止未产生正文状态。
  assert.throws(() => assertConversationForkable({ mode: 'story', regenInProgress: true, messages: [] }, { duplicate: true }), /再复制/)
  assert.throws(() => assertConversationForkable({ mode: 'story', messages: [{ role: 'user', text: 'hi' }] }, { duplicate: true }), /不能复制/)
})

const sidebarSource = readFileSync(new URL('../tavern-plugin/src/client/features/sidebar.js', import.meta.url), 'utf8')

function sidebarForkFixture({ storyDirect = false, narrow = false, failPrepare = false } = {}) {
  const calls = []
  const errors = []
  const ctx = vm.createContext({
    console,
    isPlayMode: mode => !mode || mode === 'story' || mode === 'script',
    workspaceId: 'ws-1',
    playWorkspaceIdRef: { current: 'ws-1' },
    playWorkspaceResolverRef: { current: async () => 'ws-1' },
    ensureTavernPreset: async (id, opts) => calls.push(['preset', id, opts]),
    setMenuSession: value => calls.push(['menu', value]),
    setBusy: value => calls.push(['busy', value]),
    setError: value => { errors.push(value); calls.push(['error', value]) },
    setPendingOpen: value => calls.push(['pending', value]),
    finishPendingOpen: async value => calls.push(['finishOpen', value]),
    closeHistoryManager: () => calls.push(['closeManager']),
    narrowLayout: () => narrow,
    isMissingSessionArchiveError: () => false,
    call: async (method, payload) => {
      calls.push([method, payload])
      if (method === 'prepareConversationFork') {
        if (failPrepare) throw new Error('当前正文仍在生成')
        return {
          turn: 3, sourceRevision: 8,
          atSeq: storyDirect ? null : 21,
          storyDirect,
          duplicate: Boolean(payload.duplicate)
        }
      }
      return { fork: { sessionId: 'session-copy' } }
    },
    props: {
      conversationHost: {
        forkSession: async (sessionId, atSeq, opts) => {
          calls.push(['forkSession', sessionId, atSeq, opts])
          return 'session-copy'
        },
        connectWorkspace: async wsId => {
          calls.push(['connectWorkspace', wsId])
          return 'session-copy-direct'
        }
      },
      renameChat: async (sessionId, title) => calls.push(['renameChat', sessionId, title]),
      renameSession: async (sessionId, title) => calls.push(['renameSession', sessionId, title]),
      archiveSession: async id => calls.push(['archive', id]),
      closeNarrowSidebar: () => calls.push(['closeSidebar'])
    }
  })
  vm.runInContext(sourceFunction(sidebarSource, 'forkConversation'), ctx)
  return { ctx, calls, errors }
}

test('复制完整会话走原生 fork：不自增标题序号、命名为「· 副本」并在管理面板后收起弹窗', async () => {
  const { ctx, calls } = sidebarForkFixture({ narrow: true })
  const item = { chatId: 'chat-1', sessionId: 'session-1', cardName: '铃兰', mode: 'story' }
  const created = await ctx.forkConversation(item, '夜雨旅店', 0, { duplicate: true, fromManager: true })
  assert.equal(created, 'session-copy')
  const normalized = JSON.parse(JSON.stringify(calls))
  assert.deepEqual(normalized.find(c => c[0] === 'prepareConversationFork'), ['prepareConversationFork', { chatId: 'chat-1', sessionId: 'session-1', duplicate: true }])
  assert.deepEqual(normalized.find(c => c[0] === 'forkSession'), ['forkSession', 'session-1', 21, { increaseTitle: false }])
  assert.deepEqual(normalized.find(c => c[0] === 'renameChat'), ['renameChat', 'session-copy', '夜雨旅店 · 副本'])
  assert.deepEqual(normalized.find(c => c[0] === 'finishOpen'), ['finishOpen', { sessionId: 'session-copy', targetMode: 'story' }])
  assert.ok(normalized.some(c => c[0] === 'closeManager'))
  assert.ok(normalized.some(c => c[0] === 'closeSidebar'))
})

test('复制完整会话在管理面板失败时保持面板打开并给出错误，空前缀安全走 storyDirect', async () => {
  const failed = sidebarForkFixture({ failPrepare: true })
  await assert.rejects(
    () => failed.ctx.forkConversation({ chatId: 'chat-2', sessionId: 'session-2', cardName: '卡2', mode: 'story' }, '标题', 0, { duplicate: true, fromManager: true }),
    /当前正文仍在生成/
  )
  assert.ok(!failed.calls.some(c => c[0] === 'closeManager'))
  assert.match(failed.errors.at(-1), /复制对话失败：当前正文仍在生成/)

  const fallback = sidebarForkFixture({ storyDirect: true })
  const fallbackId = await fallback.ctx.forkConversation({ chatId: 'chat-3', sessionId: 'session-3', cardName: '卡3', mode: 'story' }, '', 0, { duplicate: true })
  assert.equal(fallbackId, 'session-copy-direct')
  assert.ok(fallback.calls.some(c => c[0] === 'connectWorkspace'))
  assert.ok(fallback.calls.some(c => c[0] === 'preset' && c[1] === 'session-copy-direct'))
  assert.deepEqual(fallback.calls.find(c => c[0] === 'renameChat'), ['renameChat', 'session-copy-direct', '卡3的新对话 · 副本'])
})
