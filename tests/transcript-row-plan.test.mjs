import test from 'node:test'
import assert from 'node:assert/strict'
import { createTranscriptFold, planTranscriptRows, planTranscriptWindow, planShowsRow, planStoryTurn } from '../tavern-plugin/lib/domain/transcript-row-plan.js'

const model = { kind: 'model', provider: 'test', model: 'test' }
const story = n => ({ source: { ...model, tavernStoryTurn: n } })
const reply = (seq, turn, text, extra = {}, step = 1) => ({ seq, type: 'assistant/message', surfaceOp: 'append', data: { turn, step, message: { role: 'assistant', content: [{ type: 'text', text }], source: model, ...extra } } })
const input = (seq, source = { kind: 'user' }) => ({ seq, type: 'user/message', surfaceOp: 'append', data: { role: 'user', content: [{ type: 'text', text: '输入' }], source } })
const mark = (seq, type, turn, step = 1) => ({ seq, type, data: { turn, step, reason: { kind: 'completed' } } })
const floors = turns => turns.flatMap(turn => [{ role: 'user' }, { role: 'assistant', turn }])
const chat = turns => ({ messages: floors(turns) })
const plain = plan => Object.fromEntries(Object.keys(plan).map(key => [key, plan[key]]))
// A round as the log writes it, numbered from `seq`.
function round(seq, turn, text = '正文') {
  return [mark(seq, 'turn/start', turn), input(seq + 1), reply(seq + 2, turn, text), mark(seq + 3, 'step/end', turn), mark(seq + 4, 'turn/end', turn)]
}

test('最后一轮还在跑、或失败停在那里：这一轮原样显示；回退掉的和作废的生成期回合藏起来', () => {
  const running = [...round(0, 1), mark(5, 'turn/start', 2), input(6)]
  assert.deepEqual(plain(planTranscriptRows({ chat: chat([1]), events: running })), {})
  const failed = [...running, reply(7, 2, '半截'), mark(8, 'step/end', 2), { seq: 9, type: 'turn/end', data: { turn: 2, reason: { kind: 'error' } } }]
  assert.deepEqual(plain(planTranscriptRows({ chat: chat([1]), events: failed })), {})
  // A completed turn the save lacks was rolled back (rounds are saved before the turn ends).
  const rolledBack = [...running, reply(7, 2, '回退了'), mark(8, 'step/end', 2), mark(9, 'turn/end', 2)]
  assert.deepEqual(plain(planTranscriptRows({ chat: chat([1]), events: rolledBack })), { 2: { input: 0, reply: 0 } })
  const attempt = [...round(0, 1), mark(5, 'turn/start', 2), input(6, { kind: 'plugin', plugin: 'dsh-tavern-regen' }), reply(7, 2, '作废'), mark(8, 'step/end', 2), mark(9, 'turn/end', 2)]
  assert.deepEqual(plain(planTranscriptRows({ chat: chat([1]), events: attempt })), { 2: { input: 0, reply: 0 } })
})

// The fold is fed in pieces in the app: one event at a time, the save from the first
// changed floor on. Any order of feeding must land on the plan fed everything at once.
test('逐条喂入日志、按变化喂入存档，结果和一次喂完完全相同', () => {
  const regen = [...round(0, 1, '旧'), mark(5, 'turn/start', 2), input(6, { kind: 'plugin', plugin: 'dsh-tavern-regen' }), reply(7, 2, '新'), mark(8, 'step/end', 2), mark(9, 'turn/end', 2),
    mark(10, 'turn/start', 3), { seq: 11, type: 'assistant/message', surfaceOp: { op: 'replace', start: 2, end: 7 }, data: { turn: 3, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '新' }], ...story(1) } } },
    mark(12, 'step/end', 3), mark(13, 'turn/end', 3), ...round(14, 4)]
  const save = floors([1, 4])
  const whole = plain(planTranscriptRows({ chat: { messages: save }, events: regen }))
  const fold = createTranscriptFold()
  fold.setFloors(0, save.slice(0, 2))
  for (let index = 0; index < regen.length; index++) {
    fold.addEvents(regen.slice(0, index + 1))
    if (index === 15) fold.setFloors(2, save.slice(2))
    fold.result()
  }
  assert.deepEqual(plain(fold.result()), whole)
  // A rollback of the last round, then the round played again.
  fold.setFloors(2, [])
  fold.setFloors(2, save.slice(2))
  assert.deepEqual(plain(fold.result()), whole)
})

// A long game, every 5th round regenerated once (attempt turn + projection edit turn).
function longGame(rounds) {
  const events = [], save = []
  let turn = 0
  for (let index = 1; index <= rounds; index++) {
    const own = ++turn, seq = events.length
    events.push(...round(seq, own, '第 ' + index + ' 轮'))
    save.push(...floors([own]))
    if (index % 5 === 0) {
      const attempt = ++turn, edit = ++turn, at = events.length
      events.push(mark(at, 'turn/start', attempt), input(at + 1, { kind: 'plugin', plugin: 'dsh-tavern-regen' }), reply(at + 2, attempt, '新'), mark(at + 3, 'step/end', attempt), mark(at + 4, 'turn/end', attempt),
        mark(at + 5, 'turn/start', edit), { seq: at + 6, type: 'assistant/message', surfaceOp: { op: 'replace', start: seq + 2, end: at + 2 }, data: { turn: edit, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '新' }], ...story(own) } } },
        mark(at + 7, 'step/end', edit), mark(at + 8, 'turn/end', edit))
    }
  }
  return { events, save }
}

test('按窗口算：窗口内每个原生轮的结论与全量计算相同，窗口之前原样显示', () => {
  const { events, save } = longGame(60)
  const whole = planTranscriptRows({ chat: { messages: save }, events })
  const window = planTranscriptWindow({ messages: save.slice(-48), events, partial: true })
  assert.ok(window.from > 1)
  for (let turn = 1; turn <= events.filter(event => event.type === 'turn/start').length + 5; turn++) {
    for (const kind of ['user', 'turn-trigger', 'assistant-step', 'turn-tail']) {
      const planned = planShowsRow(window.turns, { turn, kind }, window.from)
      // Before the window: shown as the host draws it, until scrolling widens the window.
      if (turn < window.from) assert.equal(planned, true)
      else assert.equal(planned, planShowsRow(whole, { turn, kind }), `原生轮 ${turn} ${kind}`)
    }
  }
})

// Count the log events the window plan touches: it must not grow with the game.
// #311: an old save repaired many times and rolled back twice. The log's prose is
// replaced by placeholders (tests/fixtures/transcript/issue-311.json); the save holds the
// opening and rounds 2, 3, 5 and 12.
test('#311 旧存档：只画存档里五轮各一份输入与正文，修复副本与已回退的轮都不画', async () => {
  const { readFile } = await import('node:fs/promises')
  const { events } = JSON.parse(await readFile(new URL('./fixtures/transcript/issue-311.json', import.meta.url), 'utf8'))
  const messages = [{ role: 'assistant', greeting: true, turn: 1 }, ...[2, 3, 5, 12].flatMap(turn => [{ role: 'user', turn }, { role: 'assistant', turn }])]
  const plan = planTranscriptRows({ chat: { messages }, events })
  const turns = [...new Set(events.filter(event => event.type === 'turn/start').map(event => event.data.turn))]
  const shown = kind => turns.filter(turn => planShowsRow(plan, { turn, kind }))
  assert.deepEqual(shown('user'), [1, 2, 3, 5, 12])
  assert.deepEqual(shown('assistant-step'), [1, 2, 3, 11, 14])
  assert.deepEqual([11, 14].map(turn => planStoryTurn(plan, turn)), [5, 12])
})

const seededUser = (seq, { standalone = false, storyTurn = null, text = '前置输入' } = {}) => ({
  seq,
  type: 'user/message',
  surfaceOp: 'append',
  data: {
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind: 'user',
      repair: {
        id: 'seed-test',
        seeded: true,
        ...(standalone ? { standalone: true } : {}),
        ...(storyTurn !== null ? { storyTurn } : {}),
      }
    }
  }
})

const seededReply = (seq, turn, storyTurn, text = '播种正文') => ({
  seq,
  type: 'assistant/message',
  surfaceOp: 'append',
  data: {
    turn,
    step: 1,
    message: {
      role: 'assistant',
      content: [{ type: 'text', text }],
      source: { kind: 'model', provider: 'dsh-tavern', model: 'native-repair', tavernStoryTurn: storyTurn }
    }
  }
})

test('跳号分叉+重摇跨窗口与 keep===0 下 planTranscriptWindow({ partial: true }) 及增量 fold 与全量完全一致', () => {
  // 构建长前置分叉会话：1=开场，2..3=两句前置 standalone，4=跳号第6轮，5=attempt重摇，6=replace第6轮，7..10=新普通轮
  const events = []
  const push = ev => { const seq = events.length; const item = { ...ev, seq }; events.push(item); return item }
  // native 1: 开场 (story 1)
  push(mark(0, 'turn/start', 1))
  push(seededUser(0, { storyTurn: 1, text: '' }))
  push(seededReply(0, 1, 1, '开场白'))
  push(mark(0, 'step/end', 1))
  push(mark(0, 'turn/end', 1))
  // native 2, 3: 两条无轮号前置 standalone
  push(mark(0, 'turn/start', 2))
  push(seededUser(0, { standalone: true, text: '前置1' }))
  push(mark(0, 'turn/end', 2))
  push(mark(0, 'turn/start', 3))
  push(seededUser(0, { standalone: true, text: '前置2' }))
  push(mark(0, 'turn/end', 3))
  // native 4: seeded 第6轮
  push(mark(0, 'turn/start', 4))
  const u6 = push(seededUser(0, { storyTurn: 6, text: '行动6' }))
  const a6 = push(seededReply(0, 4, 6, '原正文6'))
  push(mark(0, 'step/end', 4))
  push(mark(0, 'turn/end', 4))
  // native 5 + 6: 对第6轮执行重摇（attempt 5 + replace 6），将 reply 移至原生 5
  push(mark(0, 'turn/start', 5))
  push(input(0, { kind: 'plugin', plugin: 'dsh-tavern-regen' }))
  const a5 = push(reply(0, 5, '重摇6'))
  push(mark(0, 'step/end', 5))
  push(mark(0, 'turn/end', 5))
  push(mark(0, 'turn/start', 6))
  push({
    type: 'assistant/message',
    surfaceOp: { op: 'replace', start: a6.seq, end: a5.seq },
    data: { turn: 6, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '重摇6' }], ...story(6) } }
  })
  push(mark(0, 'step/end', 6))
  push(mark(0, 'turn/end', 6))
  // native 7..10: 后续普通玩家回合
  for (const t of [7, 8, 9, 10]) {
    const base = events.length
    events.push(...round(base, t, `正文${t}`))
  }

  const allMessages = [
    { role: 'assistant', turn: 1, greeting: true },
    { role: 'user', text: '前置1' },
    { role: 'user', text: '前置2' },
    { role: 'user', text: '行动6' },
    { role: 'assistant', turn: 6, nativeAnchor: { formatVersion: 4, turn: 4, input: u6.seq, reply: a6.seq } },
    ...floors([7, 8, 9, 10]),
  ]
  const whole = planTranscriptRows({ chat: { messages: allMessages }, events })

  // 窗口 A：从前置2（缺前置1）及之后截取，检验窗口向前回溯至前置 standalone 且 from 真实可靠。
  const winA = planTranscriptWindow({ messages: allMessages.slice(2), events, partial: true })
  assert.ok(winA.from !== null && winA.from <= 3)
  for (let turn = 1; turn <= 10; turn++) {
    for (const kind of ['user', 'assistant-step']) {
      if (turn >= winA.from) assert.equal(planShowsRow(winA.turns, { turn, kind }, winA.from), planShowsRow(whole, { turn, kind }), `winA native=${turn} ${kind}`)
    }
    if (turn >= winA.from) assert.equal(planStoryTurn(winA.turns, turn), planStoryTurn(whole, turn))
  }

  // 窗口 B：仅从第6轮（含配对 user 行动6）截入，校验重摇跨窗口与 keep===0 增量 fold 等价性。
  const winB = planTranscriptWindow({ messages: allMessages.slice(3), events, partial: true })
  assert.ok(winB.from !== null && winB.from <= 4)
  assert.equal(planShowsRow(winB.turns, { turn: 4, kind: 'user' }, winB.from), true)
  assert.equal(planShowsRow(winB.turns, { turn: 4, kind: 'assistant-step' }, winB.from), false)
  assert.equal(planShowsRow(winB.turns, { turn: 5, kind: 'assistant-step' }, winB.from), true)
  assert.equal(planStoryTurn(winB.turns, 5), 6)

  // keep === 0（无保留轮全空起步）增量逐事件喂入 + 分批 setFloors 与全量计划完全一致。
  const fold = createTranscriptFold()
  fold.setFloors(0, [])
  for (let i = 0; i < events.length; i++) {
    fold.addEvents(events.slice(0, i + 1))
    if (i === 18) fold.setFloors(0, allMessages.slice(0, 5))
    if (i === 28) fold.setFloors(5, allMessages.slice(5, 9))
    fold.result()
  }
  fold.setFloors(9, allMessages.slice(9))
  assert.deepEqual(plain(fold.result()), plain(whole))
})

test('无轮号尾部 pendingSeededStandalone 遇普通轮 error 失败重开不丢失，被 replace 覆盖后不再幽灵复活', () => {
  const events = []
  const push = ev => { const seq = events.length; const item = { ...ev, seq }; events.push(item); return item }
  push(mark(0, 'turn/start', 1))
  push(seededUser(0, { storyTurn: 1, text: '' }))
  push(seededReply(0, 1, 1, '开场'))
  push(mark(0, 'turn/end', 1))
  // 尾部两句无 storyTurn 的 seeded standalone
  push(mark(0, 'turn/start', 2))
  push(seededUser(0, { standalone: true, text: '尾悬空A' }))
  push(mark(0, 'turn/end', 2))
  push(mark(0, 'turn/start', 3))
  const u3 = push(seededUser(0, { standalone: true, text: '尾悬空B' }))
  push(mark(0, 'turn/end', 3))

  const baseChat = {
    messages: [
      { role: 'assistant', turn: 1, greeting: true },
      { role: 'user', text: '尾悬空A' },
      { role: 'user', text: '尾悬空B' },
    ]
  }
  // 后续第 4 轮先失败（error），未写入 chat。
  push(mark(0, 'turn/start', 4))
  push(input(0))
  push(reply(0, 4, '失败半截'))
  push(mark(0, 'step/end', 4))
  push({ type: 'turn/end', data: { turn: 4, reason: { kind: 'error' } } })

  const duringErr = planTranscriptRows({ chat: baseChat, events })
  assert.equal(planShowsRow(duringErr, { turn: 2, kind: 'user' }), true)
  assert.equal(planShowsRow(duringErr, { turn: 3, kind: 'user' }), true)
  assert.equal(planShowsRow(duringErr, { turn: 4, kind: 'user' }), true)

  // 再开第 5 轮普通玩家回合成功并落盘到 chat：两条 tailStandalone 依然稳定显示。
  events.push(...round(events.length, 5, '正式第5轮'))
  const afterSuccessChat = {
    messages: [...baseChat.messages, { role: 'user', turn: 5 }, { role: 'assistant', turn: 5 }]
  }
  const afterSuccess = planTranscriptRows({ chat: afterSuccessChat, events })
  assert.equal(planShowsRow(afterSuccess, { turn: 2, kind: 'user' }), true)
  assert.equal(planShowsRow(afterSuccess, { turn: 3, kind: 'user' }), true)
  assert.equal(planShowsRow(afterSuccess, { turn: 5, kind: 'assistant-step' }), true)

  // 删掉最老的一条尾悬空（A）只剩一条：尾部优先留存 native 3、隐藏 native 2。
  const trimOneChat = {
    messages: [baseChat.messages[0], baseChat.messages[2], { role: 'user', turn: 5 }, { role: 'assistant', turn: 5 }]
  }
  const afterTrimOne = planTranscriptRows({ chat: trimOneChat, events })
  assert.equal(planShowsRow(afterTrimOne, { turn: 2, kind: 'user' }), false)
  assert.equal(planShowsRow(afterTrimOne, { turn: 3, kind: 'user' }), true)

  // 若一个非保留型 replace 范围抹除了 u3（如修复/回滚清理），即使存档里还留有对应位置用户消息也不幽灵复活 native 3。
  const withReplace = [
    ...events,
    mark(events.length, 'turn/start', 6),
    {
      seq: events.length + 1,
      type: 'user/message',
      surfaceOp: { op: 'replace', start: u3.seq, end: u3.seq },
      data: { id: 'cleanup', role: 'user', content: [], source: { kind: 'plugin:dsh-tavern-context-window' } }
    },
    mark(events.length + 2, 'turn/end', 6),
  ]
  const erasedPlan = planTranscriptRows({ chat: afterSuccessChat, events: withReplace })
  assert.equal(planShowsRow(erasedPlan, { turn: 3, kind: 'user' }), false)
  assert.equal(planShowsRow(erasedPlan, { turn: 2, kind: 'user' }), true)
})

test('多条显式同 storyTurn standalone 尾部逆序可逐条独立删减，openingInputDeleted 隐藏开场输入', () => {
  const events = []
  const push = ev => { const seq = events.length; const item = { ...ev, seq }; events.push(item); return item }
  push(mark(0, 'turn/start', 1))
  push(seededUser(0, { storyTurn: 1, text: '' }))
  push(seededReply(0, 1, 1, '开场'))
  push(mark(0, 'turn/end', 1))
  // 同一 storyTurn = 5 下写入 2 条显式 standalone + 1 轮配对第 5 轮
  push(mark(0, 'turn/start', 2))
  push(seededUser(0, { standalone: true, storyTurn: 5, text: '补5-a' }))
  push(mark(0, 'turn/end', 2))
  push(mark(0, 'turn/start', 3))
  push(seededUser(0, { standalone: true, storyTurn: 5, text: '补5-b' }))
  push(mark(0, 'turn/end', 3))
  push(mark(0, 'turn/start', 4))
  push(seededUser(0, { storyTurn: 5, text: '配对5' }))
  push(seededReply(0, 4, 5, '正文5'))
  push(mark(0, 'turn/end', 4))

  const full = [
    { role: 'assistant', turn: 1, greeting: true, openingInputDeleted: true },
    { role: 'user', turn: 5 },
    { role: 'user', turn: 5 },
    { role: 'user', turn: 5 },
    { role: 'assistant', turn: 5 },
  ]
  const pFull = planTranscriptRows({ chat: { messages: full }, events })
  // openingInputDeleted: true 隐藏第 1 轮开场输入但保留开场助手正文
  assert.equal(planShowsRow(pFull, { turn: 1, kind: 'user' }), false)
  assert.equal(planShowsRow(pFull, { turn: 1, kind: 'assistant-step' }), true)
  assert.deepEqual([2, 3, 4].map(t => planShowsRow(pFull, { turn: t, kind: 'user' })), [true, true, true])

  // 删掉一条前置 standalone 后，只隐藏最早的 native 2，保留 native 3 与配对 native 4
  const minusOne = [full[0], full[2], full[3], full[4]]
  const pMinusOne = planTranscriptRows({ chat: { messages: minusOne }, events })
  assert.deepEqual([2, 3, 4].map(t => planShowsRow(pMinusOne, { turn: t, kind: 'user' })), [false, true, true])

  // 再删一条只剩配对输入与助手：native 2 和 3 都隐藏，仅 native 4 展示
  const onlyPaired = [full[0], full[3], full[4]]
  const pPaired = planTranscriptRows({ chat: { messages: onlyPaired }, events })
  assert.deepEqual([2, 3, 4].map(t => planShowsRow(pPaired, { turn: t, kind: 'user' })), [false, false, true])

  // 再连同第 5 轮助手也删掉只剩一条 user(turn: 5)：配对退化入池，末尾优先保留 native 4、隐藏 native 2 和 3
  const onlyOneUser = [full[0], full[3]]
  const pOneUser = planTranscriptRows({ chat: { messages: onlyOneUser }, events })
  assert.equal(planShowsRow(pOneUser, { turn: 4, kind: 'assistant-step' }), false)
  assert.deepEqual([2, 3, 4].map(t => planShowsRow(pOneUser, { turn: t, kind: 'user' })), [false, false, true])

  // 全删空（且无 openingInputDeleted）时恢复开场输入显示，第 5 轮全部隐藏
  const bareOpening = [{ role: 'assistant', turn: 1, greeting: true }]
  const pBare = planTranscriptRows({ chat: { messages: bareOpening }, events })
  assert.equal(planShowsRow(pBare, { turn: 1, kind: 'user' }), true)
  assert.deepEqual([2, 3, 4].map(t => planShowsRow(pBare, { turn: t, kind: 'user' })), [false, false, false])
})

test('分叉重摇后 currentOpen / attempt / keepInput 不把已提交旧 origin 误判为未落盘开放轮，保留正常失败重投 keepInput', () => {
  const events = []
  const push = ev => { const seq = events.length; const item = { ...ev, seq }; events.push(item); return item }
  push(mark(0, 'turn/start', 1))
  push(seededUser(0, { storyTurn: 1, text: '' }))
  push(seededReply(0, 1, 1, '开场'))
  push(mark(0, 'turn/end', 1))
  push(mark(0, 'turn/start', 2))
  const u2 = push(seededUser(0, { storyTurn: 2, text: '行动2' }))
  const a2 = push(seededReply(0, 2, 2, '正文2'))
  push(mark(0, 'turn/end', 2))
  // 已提交过一轮重摇：attempt 3 + replace 4
  push(mark(0, 'turn/start', 3))
  push(input(0, { kind: 'plugin', plugin: 'dsh-tavern-regen' }))
  const a3 = push(reply(0, 3, '重摇A'))
  push(mark(0, 'turn/end', 3))
  push(mark(0, 'turn/start', 4))
  const r4 = push({
    type: 'assistant/message',
    surfaceOp: { op: 'replace', start: a2.seq, end: a3.seq },
    data: { turn: 4, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: '重摇A' }], ...story(2) } }
  })
  push(mark(0, 'turn/end', 4))
  // 又触发一次正在进行中的重摇 attempt 5（无 playerInput），替换目标为旧 origin 2（其最新显示轮为 3）
  push(mark(0, 'turn/start', 5))
  push(input(0, { kind: 'plugin', plugin: 'dsh-tavern-regen' }))
  push(reply(0, 5, '正在流式'))
  push({ type: 'turn/end', data: { turn: 5, reason: { kind: 'error' } } })

  const chatSaved = {
    messages: [
      { role: 'assistant', turn: 1, greeting: true },
      { role: 'user', text: '行动2' },
      { role: 'assistant', turn: 2, nativeAnchor: { formatVersion: 4, turn: 2, input: u2.seq, reply: a2.seq } }
    ]
  }
  const fold = createTranscriptFold()
  fold.setFloors(0, chatSaved.messages.map(m => ({ role: m.role, turn: m.turn, greeting: m.greeting, nativeTurn: m.nativeAnchor?.turn })))
  fold.addEvents(events, 0)
  // 模拟一次针对 3（旧替代轮）的重摇正在运行；先前真正失败的轮 6 已被重投轮 7 接管重试，因此 keepInput([6]) 生效
  push(mark(0, 'turn/start', 6))
  push(input(0))
  push({ type: 'turn/end', data: { turn: 6, reason: { kind: 'error' } } })
  push(mark(0, 'turn/start', 7))
  push(input(0, { kind: 'plugin', plugin: 'dsh-tavern-replay' }))
  push({ type: 'turn/end', data: { turn: 7, reason: { kind: 'completed' } } })
  fold.addEvents(events, events.length - 6)
  fold.setRegeneration({ replacing: [3], inProgress: true })
  fold.setKeepInput([6])
  const duringRegen = fold.result()

  // 原先旧 origin 2 的输入必须保留，不能把已落盘的旧轮当成 open turn 而放行旧正文，也不能吞掉失败重投的 keepInput 轮 6
  assert.notEqual(fold.open, 2)
  assert.notEqual(fold.open, 3)
  assert.equal(planShowsRow(duringRegen, { turn: 2, kind: 'user' }), true)
  assert.equal(planShowsRow(duringRegen, { turn: 3, kind: 'assistant-step' }), false)
  assert.equal(duringRegen['6']?.kept, 1)
  assert.equal(planShowsRow(duringRegen, { turn: 6, kind: 'user' }), true)
  assert.equal(planShowsRow(duringRegen, { turn: 6, kind: 'assistant-step' }), false)
  assert.equal(fold.open, null)
  // 撤销 replacing 并把 attempt 5 当作最后流式轮（去掉轮 6/7）检验 attempt 分支返回正确 story: 2
  const foldAttempt = createTranscriptFold()
  foldAttempt.setFloors(0, chatSaved.messages.map(m => ({ role: m.role, turn: m.turn, greeting: m.greeting, nativeTurn: m.nativeAnchor?.turn })))
  foldAttempt.addEvents(events.slice(0, -7), 0)
  foldAttempt.setRegeneration({ replacing: [3], inProgress: true })
  const attemptPlan = foldAttempt.result()
  assert.equal(attemptPlan['5']?.input, 0)
  assert.equal(attemptPlan['5']?.reply, 1)
  assert.equal(attemptPlan['5']?.story, 2)
  assert.equal(planShowsRow(attemptPlan, { turn: 2, kind: 'user' }), true)
  assert.equal(planShowsRow(attemptPlan, { turn: 3, kind: 'user' }), false)
  assert.equal(planShowsRow(attemptPlan, { turn: 3, kind: 'assistant-step' }), false)
  // 注意 r4 已归档为沉默 edit 轮（确保即使后续再生，r4 仍保持隐藏）
  assert.equal(planShowsRow(attemptPlan, { turn: 4, kind: 'assistant-step' }), false)
  assert.ok(r4.seq > a3.seq)
})
