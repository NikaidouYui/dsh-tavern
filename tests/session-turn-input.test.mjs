import test from 'node:test'
import assert from 'node:assert/strict'
import { Session } from './fixtures/dsh-session-host.mjs'
import { appendSessionEvent } from '../tavern-plugin/lib/domain/session-events.js'
import { synchronizeTemplateHistory } from '../tavern-plugin/lib/domain/template-history.js'

const input = (id, text, rpcId) => ({ id, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user', rpcId } })
const reply = (id, turn, text) => ({ turn, step: 1, message: { id, role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'test', model: 'test' } } })

test('重新生成时模板改写同步落在本次尝试中，不会被当成新的玩家输入而截断尝试或阻止撤销（#196）', async () => {
  const { planRegenerationSurface } = await import('../tavern-plugin/lib/domain/rollback-surface.js')
  const { sessionEvents } = await import('../tavern-plugin/lib/domain/session-events.js')
  const session = Session.create('regen-template-edit')
  appendSessionEvent(session, 'turn/start', { turn: 1 })
  appendSessionEvent(session, 'user/message', input('in-1', '原始输入', 'rpc-1'), { surfaceOp: 'append' })
  const old = appendSessionEvent(session, 'assistant/message', reply('out-1', 1, '第一轮正文'), { surfaceOp: 'append' })
  appendSessionEvent(session, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
  const eventStart = sessionEvents(session).length
  appendSessionEvent(session, 'turn/start', { turn: 2 })
  await synchronizeTemplateHistory(session, { messages: [{ role: 'user', text: '模板改写后的输入', templateInputSource: '原始输入' }, { role: 'assistant', text: '第一轮正文' }] }, async () => {})
  appendSessionEvent(session, 'user/message', { id: 'regen', role: 'user', content: [{ type: 'text', text: '原始输入' }], source: { kind: 'plugin', plugin: 'dsh-tavern-regen' } }, { surfaceOp: 'append' })
  const fresh = appendSessionEvent(session, 'assistant/message', reply('new', 2, '新正文'), { surfaceOp: 'append' })
  appendSessionEvent(session, 'turn/end', { turn: 2, reason: { kind: 'completed' } })
  const plan = planRegenerationSurface({ events: sessionEvents(session), nodes: session.surface.nodes, oldAssistantSeq: old.seq, eventStart })
  assert.equal(plan.finalAssistantSeq, fresh.seq)
})

test('找出模型看过、存档却没记下的已完成轮次；回退、失败、重新生成的轮次不算（#196 自愈）', async () => {
  const { uncommittedRounds } = await import('../tavern-plugin/lib/domain/uncommitted-rounds.js')
  const { replaceSessionSurface } = await import('../tavern-plugin/lib/domain/session-surface-mutations.js')
  const session = Session.create('uncommitted')
  const round = (turn, text, rpcId, reason = 'completed') => {
    appendSessionEvent(session, 'turn/start', { turn })
    appendSessionEvent(session, 'user/message', input('in-' + turn, text, rpcId), { surfaceOp: 'append' })
    const out = appendSessionEvent(session, 'assistant/message', reply('out-' + turn, turn, text + '的回复'), { surfaceOp: 'append' })
    appendSessionEvent(session, 'turn/end', { turn, reason: { kind: reason } })
    return out
  }
  round(1, '第一轮', 'rpc-1')
  round(2, '第二轮', 'rpc-2')
  round(3, '失败的一轮', 'rpc-3', 'error')
  round(4, '漏记的一轮', 'rpc-4')
  const rolled = round(5, '已回退的一轮', 'rpc-5')
  replaceSessionSurface(session, 'assistant/message', { turn: 5, step: 1, message: { id: 'tomb', role: 'assistant', content: [], source: { kind: 'model', provider: 'test', model: 'test' } } }, { start: rolled.seq, end: rolled.seq, sourceEventSeqs: [rolled.seq] })
  round(6, '重新生成的合成轮', 'rpc-6')
  const header = { nativeCommits: { 1: { turn: 1 }, 2: { turn: 2 } }, suppressedDshTurns: [6] }
  assert.deepEqual(uncommittedRounds(session, header).map(item => [item.turn, item.requestId, item.userText, item.assistantText]), [[4, 'rpc-4', '漏记的一轮', '漏记的一轮的回复']])
  assert.deepEqual(uncommittedRounds(session, { nativeCommits: {} }), [], 'saves without commit records are left alone')
})

test('uncommittedRounds 在故事分叉跳号/重摇 regeneratedDshTurns 下统一使用宿主原生轮坐标，不反转或抬高 latest 漏报未提交轮', async () => {
  const { uncommittedRounds } = await import('../tavern-plugin/lib/domain/uncommitted-rounds.js')
  const session = Session.create('fork-uncommitted-native-coord')
  const playRound = (turn, userText, rpcId, assistantText) => {
    appendSessionEvent(session, 'turn/start', { turn })
    appendSessionEvent(session, 'user/message', input(`u-${turn}`, userText, rpcId), { surfaceOp: 'append' })
    appendSessionEvent(session, 'assistant/message', reply(`a-${turn}`, turn, assistantText), { surfaceOp: 'append' })
    appendSessionEvent(session, 'turn/end', { turn, reason: { kind: 'completed' } })
  }
  playRound(1, '开场', 'rpc-1', '开场正文')
  playRound(2, '原第2轮', 'rpc-2', '旧第2轮正文')
  playRound(4, '分叉故事20落地于原生4', 'rpc-4', '第4轮回复')
  playRound(5, '续聊第5轮', 'rpc-5', '第5轮回复')
  playRound(6, '针对故事2的重摇合成轮', 'rpc-6', '重摇正文6')
  playRound(7, '分叉后漏记的第7轮', 'rpc-7', '漏记第7轮的回复')

  // storyTurn 20 映射到 hostTurn 4、storyTurn 2 映射到 hostTurn 6；
  // 旧逻辑若对 { 20: 4 } 错误求逆会把 hostTurn 4 当成 20，抬高 latest 导致 hostTurn 7 被误吞。
  const header = {
    nativeCommits: { 1: { turn: 1 }, 4: { turn: 4 }, 5: { turn: 5 } },
    regeneratedDshTurns: { 20: 4, 2: 6 },
    suppressedDshTurns: [6],
  }
  const found = uncommittedRounds(session, header)
  assert.deepEqual(found.map(item => [item.turn, item.requestId, item.userText, item.assistantText, item.nativeAnchor?.turn]), [
    [7, 'rpc-7', '分叉后漏记的第7轮', '漏记第7轮的回复', 7],
  ])

  // 若仅有高原生轮重摇记录（如 hostTurn 8 尚未计入 nativeCommits）而在它之后新增了 hostTurn 9：
  // 8 作为 latest 跳过不回捞旧轮，且 native 9 > 8 应准确检出为 9。
  playRound(8, '高原生轮重摇', 'rpc-8', '重摇正文8')
  playRound(9, '后续真漏记第9轮', 'rpc-9', '漏记第9轮回复')
  const headerWithRegen8 = {
    nativeCommits: { 1: { turn: 1 }, 4: { turn: 4 } },
    regeneratedDshTurns: { 20: 8 },
    suppressedDshTurns: [6, 8],
  }
  assert.deepEqual(
    uncommittedRounds(session, headerWithRegen8).map(item => [item.turn, item.requestId, item.nativeAnchor?.turn]),
    [[9, 'rpc-9', 9]]
  )
})
