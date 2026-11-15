import assert from 'node:assert/strict'
import test from 'node:test'
import { assertConversationForkable } from '../tavern-plugin/lib/domain/conversation-fork.js'

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
