import assert from 'node:assert/strict'
import test from 'node:test'
import { createBackgroundNativeRuntime } from './fixtures/background-native-runtime.mjs'
import { createPolishDraft, createPolishReviewer, POLISH_TOOLS } from '../tavern-plugin/lib/domain/polish-agent.js'
import { prompt } from '../tavern-plugin/lib/prompt-catalog.js'

test('真实 DSH：精修工具逐处执行、完成后不再请求模型，跨轮/空闲恢复保留相同前缀', { skip: !process.env.DSH_BOOT_MODULE, timeout: 30000 }, async t => {
  let now = 0
  const runtime = await createBackgroundNativeRuntime(process.env.DSH_BOOT_MODULE, {
    residentOptions: { now: () => now, residentIdleMs: 1000, backgroundTools: [{ name: 'other_tool', description: 'Other task only', parameters: { type: 'object' } }] },
    modelResponse: (input, n) => input.tools.some(tool => tool.name === 'polish_edit') ? [
      { type: 'tool-call', id: 'edit-' + n, name: 'polish_edit', arguments: JSON.stringify({ reason: '更具体', find: '甲。', replace: '甲改。' }) },
      { type: 'tool-call', id: 'finish-' + n, name: 'polish_finish', arguments: '{}' }
    ] : [{ type: 'text', text: '普通后台完成' }]
  })
  t.after(() => runtime.dispose())
  const run = async (body, persistentSessionId) => {
    const draft = createPolishDraft(['甲。'])
    const result = await runtime.runBackground({ sessionId: 'scene-parent', task: 'polish', persistent: true, persistentSessionId,
      selection: { provider: 'scene-fixture', model: 'fixture-text' }, system: '固定精修标准和人物设定', taskText: () => body,
      tools: POLISH_TOOLS, onToolCall: call => draft.call(call), stopToolsWhen: () => draft.finished, acceptWithoutText: () => draft.finished })
    assert.equal(draft.finished, true)
    assert.equal(draft.result().edits.length, 1)
    return result
  }
  const first = await run('正文第一轮：甲。')
  assert.equal(runtime.requests.length, 1, '完成工具应直接结束，不额外请求总结')
  assert.deepEqual(runtime.requests[0].tools.map(tool => tool.name).sort(), ['polish_edit', 'polish_finish'])
  const second = await run('正文第二轮：甲。', first.traceSessionId)
  assert.equal(second.traceSessionId, first.traceSessionId)
  assert.deepEqual(runtime.requests[1].system, runtime.requests[0].system)
  assert.deepEqual(runtime.requests[1].tools, runtime.requests[0].tools)
  assert.deepEqual(runtime.requests[1].messages.slice(0, runtime.requests[0].messages.length), runtime.requests[0].messages)
  now = 1000
  await runtime.reapBackground()
  assert.deepEqual(runtime.backgroundLoaded(first.traceSessionId), { agent: false, session: false })
  await runtime.restart()
  const third = await run('正文第三轮：甲。', first.traceSessionId)
  assert.equal(third.traceSessionId, first.traceSessionId)
  assert.deepEqual(runtime.requests[2].system, runtime.requests[0].system)
  assert.deepEqual(runtime.requests[2].tools, runtime.requests[0].tools)
  assert.match(JSON.stringify(runtime.requests[2].messages), /正文第一轮/)
  const ordinary = await runtime.runBackground({ sessionId: 'scene-parent', task: 'candidate', persistent: true,
    selection: { provider: 'scene-fixture', model: 'fixture-text' }, messages: [], tools: [] })
  assert.notEqual(ordinary.traceSessionId, first.traceSessionId)
  assert.ok(!runtime.requests.at(-1).tools.some(tool => tool.name === 'polish_edit'))
})

test('真实 DSH：正文精修失败重试不叠加重复正文上下文，保留已完成前轮前缀', { skip: !process.env.DSH_BOOT_MODULE, timeout: 30000 }, async t => {
  let failTurn = false
  const runtime = await createBackgroundNativeRuntime(process.env.DSH_BOOT_MODULE, {
    residentOptions: { backgroundTools: [] },
    modelResponse: (input, n) => {
      if (failTurn) return [{ type: 'text', text: '本次失败未调用完成工具' }]
      if (n === 1) {
        return [
          { type: 'tool-call', id: 'edit-' + n, name: 'polish_edit', arguments: JSON.stringify({ reason: '精炼', find: '甲。', replace: '甲改。' }) },
          { type: 'tool-call', id: 'finish-' + n, name: 'polish_finish', arguments: '{}' }
        ]
      }
      return [{ type: 'tool-call', id: 'finish-' + n, name: 'polish_finish', arguments: '{}' }]
    }
  })
  t.after(() => runtime.dispose())
  let saved = null
  const chat = { id: 'game', messages: [{ role: 'assistant', text: '开场白' }, { role: 'user', text: '继续一' }, { role: 'assistant', text: '第一轮：甲。' }] }
  const reviewer = createPolishReviewer({
    latestFloors: async () => structuredClone(chat),
    readCard: async () => ({ name: '角色', description: '固定设定' }),
    prompt,
    selection: async () => ({ provider: 'scene-fixture', model: 'fixture-text' }),
    data: { readGame: async () => structuredClone(saved), saveGame: async ({ data }) => { saved = structuredClone(data) } },
    runAgent: input => runtime.runBackground(input)
  })
  await reviewer.review('scene-parent', ['第一轮：甲。'])
  chat.messages[2].text = '第一轮：甲改。'
  chat.messages.push({ role: 'user', text: '继续二' }, { role: 'assistant', text: '第二轮独特正文XYZ。' })

  failTurn = true
  await assert.rejects(reviewer.review('scene-parent', ['第二轮独特正文XYZ。']), /未调用完成工具/)
  await assert.rejects(reviewer.review('scene-parent', ['第二轮独特正文XYZ。']), /未调用完成工具/)
  failTurn = false
  await reviewer.review('scene-parent', ['第二轮独特正文XYZ。'])

  const lastRequest = runtime.requests.at(-1)
  const userTexts = lastRequest.messages.filter(m => m.role === 'user').map(m =>
    (m.content || []).filter(block => block.type === 'text').map(block => block.text).join(''))
  assert.equal(userTexts.filter(text => text.includes('第二轮独特正文XYZ。')).length, 1, '失败重试后模型只能看到一份第二轮正文，不得叠加上次失败正文')
  assert.ok(userTexts.some(text => text.includes('第一轮：甲。')), '已完成的第一轮精修历史仍保持不变以维持前缀缓存')
  assert.doesNotMatch(JSON.stringify(lastRequest.messages), /本次失败未调用完成工具/, '失败回合的模型输出应已被回退清理')
})
