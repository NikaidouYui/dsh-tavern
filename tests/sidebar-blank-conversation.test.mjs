import test from 'node:test'
import assert from 'node:assert/strict'
import vm from './fixtures/client-vm.mjs'
import { sourceFunction } from './fixtures/source-function.mjs'
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../tavern-plugin/lib/client.js', import.meta.url), 'utf8')

function blankFixture(options = {}) {
  const calls = []
  const errors = []
  const ctx = vm.createContext({
    workspaceId: options.workspaceId ?? 'workspace-play',
    playWorkspaceIdRef: { current: options.prewarmWorkspaceId ?? '' },
    props: {
      conversationHost: {
        connectWorkspace: options.create
          ? id => options.create(id, calls)
          : async id => { calls.push(['connect', id]); return 'blank-session' },
      },
      sessions: { clear() { calls.push(['clear']) } },
    },
    openSessionWhenReady: async id => { calls.push(['open', id]) },
    setError: message => { errors.push(message) },
  })
  vm.runInContext(sourceFunction(source, 'openBlankConversation'), ctx)
  return { ctx, calls, errors }
}

function deleteFixture() {
  const calls = []
  const ctx = vm.createContext({
    current: 'session-open',
    activeHistory: [],
    setMenuSession() {}, setBusy() {}, setError() {},
    askConfirm: async () => true,
    call: async method => {
      calls.push([method])
      return method === 'prepareDeleteChats' ? { results: [{ ok: true }] } : {}
    },
    props: {
      archiveSession: async id => { calls.push(['archive', id]) },
      sessions: { clear() { calls.push(['clear']) } },
    },
    isMissingSessionArchiveError: () => false,
    openSessionWhenReady: async id => { calls.push(['open', id]) },
    openBlankConversation: async () => { calls.push(['blank']) },
    openPicker: () => { calls.push(['picker']) },
    refresh: async () => {},
  })
  vm.runInContext(sourceFunction(source, 'changeConversationArchive'), ctx)
  // (removeChat, the shared removal deleteConversation calls, sits right before it)
  vm.runInContext(source.slice(source.indexOf('async function removeChat'), source.indexOf('async function forkConversation')), ctx)
  return { ctx, calls }
}

test('删掉当前仅剩的对话时回到空白会话，而不是只清空主视图', async () => {
  const { ctx, calls } = deleteFixture()
  await ctx.deleteConversation({ sessionId: 'session-open', chatId: 'chat-1', cardName: '测试卡' }, '测试对话')
  assert.deepEqual(calls, [['prepareDeleteChats'], ['archive', 'session-open'], ['deleteChat'], ['blank'], ['picker']])
})

test('归档当前对话后切到仍在历史中的对话', async () => {
  const { ctx, calls } = deleteFixture()
  ctx.activeHistory = [{ sessionId: 'session-open' }, { sessionId: 'session-next' }]
  await ctx.changeConversationArchive({ sessionId: 'session-open' }, true)
  assert.deepEqual(calls, [['archive', 'session-open'], ['clear'], ['open', 'session-next']])
})

function forkFixture({ storyDirect = false, narrow = false, failPrepare = false } = {}) {
  const calls = []
  const errors = []
  const ctx = vm.createContext({
    console,
    isPlayMode: mode => !mode || mode === 'story' || mode === 'script',
    workspaceId: 'ws-1',
    playWorkspaceIdRef: { current: 'ws-1' },
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
  vm.runInContext(sourceFunction(source, 'forkConversation'), ctx)
  return { ctx, calls, errors }
}

test('复制完整会话走原生 fork：不自增标题序号、命名为「· 副本」并在管理面板后收起弹窗', async () => {
  const { ctx, calls } = forkFixture({ narrow: true })
  const item = { chatId: 'chat-1', sessionId: 'session-1', cardName: '铃兰', mode: 'story' }
  await ctx.forkConversation(item, '夜雨旅店', 0, { duplicate: true, fromManager: true })
  const normalized = JSON.parse(JSON.stringify(calls))
  assert.deepEqual(normalized.find(c => c[0] === 'prepareConversationFork'), ['prepareConversationFork', { chatId: 'chat-1', sessionId: 'session-1', duplicate: true }])
  assert.deepEqual(normalized.find(c => c[0] === 'forkSession'), ['forkSession', 'session-1', 21, { increaseTitle: false }])
  assert.deepEqual(normalized.find(c => c[0] === 'renameChat'), ['renameChat', 'session-copy', '夜雨旅店 · 副本'])
  assert.deepEqual(normalized.find(c => c[0] === 'finishOpen'), ['finishOpen', { sessionId: 'session-copy', targetMode: 'story' }])
  assert.ok(normalized.some(c => c[0] === 'closeManager'))
  assert.ok(normalized.some(c => c[0] === 'closeSidebar'))
})

test('复制完整会话在管理面板失败时保持面板打开并给出错误，空前缀安全走 storyDirect', async () => {
  const failed = forkFixture({ failPrepare: true })
  await failed.ctx.forkConversation({ chatId: 'chat-2', sessionId: 'session-2', cardName: '卡2', mode: 'story' }, '标题', 0, { duplicate: true, fromManager: true })
  assert.ok(!failed.calls.some(c => c[0] === 'closeManager'))
  assert.match(failed.errors.at(-1), /复制对话失败：当前正文仍在生成/)

  const fallback = forkFixture({ storyDirect: true })
  await fallback.ctx.forkConversation({ chatId: 'chat-3', sessionId: 'session-3', cardName: '卡3', mode: 'story' }, '', 0, { duplicate: true })
  assert.ok(fallback.calls.some(c => c[0] === 'connectWorkspace'))
  assert.ok(fallback.calls.some(c => c[0] === 'preset' && c[1] === 'session-copy-direct'))
  assert.deepEqual(fallback.calls.find(c => c[0] === 'renameChat'), ['renameChat', 'session-copy-direct', '卡3的新对话 · 副本'])
})
