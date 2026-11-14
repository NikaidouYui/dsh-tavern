import { surfaceReplacementRange } from './session-events.js'
import { createImmutableTurnFields } from './freeze-json.js'

// The conversation page's row plan (Wiki「设计：transcript-row-plan」). The host draws
// every append-origin message forever; instead of listing what to hide, say for each
// saved round which native turn draws its input and which draws its reply. Every other
// finished native turn draws nothing.
//
// The plan is folded incrementally: log events are append-only and fed once each, save
// floors are fed from the first floor whose shape changed. Each feed touches only the
// turns it affects, and the result is a keyed map of exceptions — a native turn absent
// from it shows its own input and reply — so neither computing, sending nor reading it
// grows with the length of the game.

function textOf(message) {
  return (message?.content || []).filter(block => block?.type === 'text').map(block => block.text).join('')
}
const storyOf = event => Number(event?.data?.message?.source?.tavernStoryTurn)
const isAppendReply = event => event?.type === 'assistant/message' && event.surfaceOp === 'append'
const stepKey = event => event?.data?.turn + ':' + event?.data?.step
const isPlayerInput = event => event?.type === 'user/message' && event.surfaceOp === 'append' && event.data?.source?.kind === 'user' && !event.data?.source?.repair
const isSeededInput = event => event?.type === 'user/message' && event.data?.source?.repair?.seeded === true
const isCompactionCheckpoint = event => event?.type === 'user/message' && event?.data?.role === 'user' && typeof event?.data?.source?.compactionId === 'string'
const validPositiveTurn = value => {
  const numeric = Number(value)
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null
}

const turnFields = createImmutableTurnFields()

/**
 * 判断一次 surface replacement 是否是在原地保持玩家或助手原轮语义、不应擦除旧用户节点的操作：
 * - compaction checkpoint 仅压缩摘要，不应隐藏历史对话中的用户输入行；
 * - 玩家仅原地编辑自己的单条提问正文时，沿用同一原生轮并在日志侧延续最新的 seq。
 */
function isPreservingUserEditReplace(event, range) {
  if (isCompactionCheckpoint(event)) return 'compaction'
  if (
    event?.type === 'user/message' &&
    event.data?.source?.kind === 'user' &&
    !event.data?.source?.repair &&
    textOf(event.data) !== '' &&
    Number(range.start) === Number(range.end)
  ) {
    return 'user-edit'
  }
  return null
}

/**
 * One game's plan, fed in pieces. `result()` returns an immutable turn-keyed map:
 * { [nativeTurn]: { input: 0|1, reply: 0|1, story?: number } } for every native turn that
 * does not simply show its own input and reply.
 */
export function createTranscriptFold() {
  // From the log.
  let folded = -1
  const turns = new Set()
  let last = null, running = false, playerInput = false, queuedInput = false, ended = ''
  let inputSeq = null, queuedSeq = null // where the last turn's player input sits in the log
  const inputTurns = new Set() // native turns opened by a non-repair player's input
  const erasedPlayerInputTurns = new Set() // 原生轮上的普通玩家输入是否已被擦除性 replace 抹除
  const playerInputSeqsByTurn = new Map() // nativeTurn -> Set<seq>
  const playerTurnBySeq = new Map() // seq -> nativeTurn

  const pending = new Map() // step -> rewrites appended in it, decided when it ends
  const stepReplies = new Map() // step -> reply appends with text
  const multiRoundRepairTurns = new Set() // 同一步写入多轮重修的合成原生轮（不单独展示）
  const singleRewriteByStory = new Map() // story -> 最后一次由单轮 rewrite 写入的原生轮（兼容无 anchor 旧档与 #311）
  const singleRewriteTurnToStory = new Map() // 非 seeded 单轮 repair 原生轮 -> 对应的 story（仅接管 reply，不接管原输入）
  const nonSeededPlayerReplyTurns = new Set() // 含自身普通玩家输入且由模型给出普通回复的非 seeded 原生轮集合
  const gameReplies = new Map() // active game projection seq -> drawable turn

  // 日志的原生 seq/turn 图谱与重摇链，彻底与 storyTurn 脱钩。
  const turnBySeq = new Map() // seq -> turn
  const seqOriginTurn = new Map() // 节点 seq -> 最初根原生轮
  const seqDrawnTurn = new Map() // 节点 seq -> 当前最新绘制原生轮
  const rootOf = new Map() // 任意衍生原生轮 -> 根原生轮
  const latestReplyOfRoot = new Map() // 根原生轮 -> 当前最新绘制原生轮
  const storyMovedTo = new Map() // 无 anchor 旧存档或日志截断时的 fallback: story -> drawnTurn
  const repairedReplyOrigins = new Set() // 日志上写入过非空 native-repair 回复的根原生轮集合

  // 分叉按轮播种与 standalone 用户记录。
  const seededRecords = [] // 全部写入顺序下的 seeded 记录
  const seededByNativeTurn = new Map() // nativeTurn -> seededRecord[]
  const seededBySeq = new Map() // currentUserSeq -> seededRecord
  const seededPairedOrigins = new Set() // 由 seeded user+assistant 成对闭合过的原生轮
  const seededExplicitByStory = new Map() // story -> standalone/孤立归属于该 story 的 seededRecord[]
  let pendingSeededStandalone = [] // 尚未匹配到助手或带显式 storyTurn 的尾部/待挂载 standalone 记录
  let unattachedTailStandalone = [] // 在没有后续 native-repair assistant 接管时悬空或接普通轮的 standalone 列表
  let pendingSeededRound = null // { nativeTurn, story, userRec }

  // From the save: one entry per floor.
  const floors = []
  let floorRevision = 0
  // 由当前 floors 解析出的楼层绑定与统计结果（纯原生坐标主导，不按 story 混查）。
  const originFloors = new Map() // boundOrigin nativeTurn -> Set<floorMeta>
  const replyFloors = new Map() // boundReply nativeTurn -> Set<floorMeta>
  const pairedOrigins = new Set() // 存档上仍保留配对 user 的 inputOrigin 原生轮
  const openingOrigins = new Set() // 存档上保留 openingInput 且未删除的开场 inputOrigin 原生轮
  const explicitStandaloneCounts = new Map() // 存档中未被配对消耗、且带显式 turn 的孤立 user 条数
  let afterSeededUntaggedCount = 0 // 最后一个已绑定 seeded 助手之后的第一簇无 turn standalone user 数量

  const dirty = new Set()
  let open = null
  // From the save: a regeneration under way (docs step 3).
  let replacing = new Set(), regenerating = false
  // From the view: void turns that keep the player's own message (a retry adopted it).
  let keepInput = new Set()
  let exceptions = turnFields.from({})

  function markOriginChainDirty(nativeTurn) {
    if (!Number.isSafeInteger(nativeTurn) || nativeTurn < 1) return
    dirty.add(nativeTurn)
    const root = rootOf.get(nativeTurn) ?? nativeTurn
    dirty.add(root)
    const moved = latestReplyOfRoot.get(root)
    if (Number.isSafeInteger(moved)) dirty.add(moved)
    for (const [derived, itsRoot] of rootOf) {
      if (itsRoot === root) dirty.add(derived)
    }
  }

  function markAllSeededDirty() {
    for (const rec of seededRecords) dirty.add(rec.nativeTurn)
  }

  function linkFloorBindings(floor, add) {
    if (floor.role !== 'assistant') return
    if (Number.isSafeInteger(floor.replyOrigin)) {
      const target = floor.boundReply
      if (Number.isSafeInteger(target)) {
        let set = replyFloors.get(target)
        if (add) {
          if (!set) replyFloors.set(target, set = new Set())
          set.add(floor)
        } else if (set) {
          set.delete(floor)
          if (!set.size) replyFloors.delete(target)
        }
        dirty.add(target)
      }
      if (Number.isSafeInteger(floor.replyOrigin)) dirty.add(floor.replyOrigin)
    }
    if (Number.isSafeInteger(floor.inputOrigin)) {
      let set = originFloors.get(floor.inputOrigin)
      if (add) {
        if (!set) originFloors.set(floor.inputOrigin, set = new Set())
        set.add(floor)
      } else if (set) {
        set.delete(floor)
        if (!set.size) originFloors.delete(floor.inputOrigin)
      }
      dirty.add(floor.inputOrigin)
    }
    if (floor.boundOrigin !== undefined && Number.isSafeInteger(floor.boundOrigin)) {
      dirty.add(floor.boundOrigin)
    }
  }

  // 在楼层序列变更或日志新增映射时，为全部 assistant 楼层重算其精确绑定坐标与前置用户输入归属。
  // 相比按 storyTurn 全局计数，此过程在长对话部分窗口中仅覆盖当前几十条视图楼层，消除撞号并保持严格一致性。
  function recomputeFloorBindings() {
    for (const set of originFloors.values()) for (const f of set) dirty.add(f.inputOrigin)
    for (const set of replyFloors.values()) for (const f of set) dirty.add(f.boundReply)
    for (const turn of pairedOrigins) dirty.add(turn)
    for (const turn of openingOrigins) dirty.add(turn)
    for (const turn of explicitStandaloneCounts.keys()) dirty.add(turn)

    originFloors.clear()
    replyFloors.clear()
    pairedOrigins.clear()
    openingOrigins.clear()
    explicitStandaloneCounts.clear()
    afterSeededUntaggedCount = 0

    // 先收集各段：相邻两 assistant 之间的 user 列表，及末尾残余 user 列表。
    const assistantSegments = []
    let segmentUsers = []
    let userBeforeCount = 0
    for (let index = 0; index < floors.length; index++) {
      const floor = floors[index]
      floor.untaggedStandaloneBefore = 0
      floor.hasPairedInput = false
      floor.inputOrigin = null
      floor.replyOrigin = null
      floor.boundOrigin = null
      floor.boundReply = null
      if (floor.role === 'user') {
        segmentUsers.push(floor)
        userBeforeCount++
        continue
      }
      if (floor.role !== 'assistant') continue
      const story = Number(floor.rawTurn) > 0 ? Number(floor.rawTurn) : (floor.greeting ? 1 : userBeforeCount + 1)
      floor.story = Number.isSafeInteger(story) && story > 0 ? story : null
      assistantSegments.push({ floor, users: segmentUsers })
      segmentUsers = []
    }
    const tailUsers = segmentUsers

    // 第一趟先记录带有显式原生锚点（且非多轮同 step 合成行）已经认领过的原生轮，
    // 防止同故事轮号下尚未写入锚点的新续聊楼层误抢占老单轮修复映射。
    const claimedOrigins = new Set()
    for (const { floor } of assistantSegments) {
      if (floor.anchorTurn !== null && !multiRoundRepairTurns.has(floor.anchorTurn)) {
        claimedOrigins.add(rootOf.get(floor.anchorTurn) ?? floor.anchorTurn)
      }
    }

    const usedRewrites = new Set()
    let lastSeededSegmentIdx = -1
    for (let segIdx = 0; segIdx < assistantSegments.length; segIdx++) {
      const { floor, users } = assistantSegments[segIdx]
      // 解析此楼层的 replyOrigin 与 inputOrigin。
      let replyOrigin = null
      let inputOrigin = null
      if (floor.anchorTurn !== null && !multiRoundRepairTurns.has(floor.anchorTurn)) {
        const root = rootOf.get(floor.anchorTurn) ?? floor.anchorTurn
        replyOrigin = root
        const isNonSeededRepairOnly =
          singleRewriteTurnToStory.has(root) &&
          !seededByNativeTurn.has(root) &&
          !inputTurns.has(root)
        if (isNonSeededRepairOnly) {
          inputOrigin = floor.story
        } else {
          inputOrigin = root
        }
      } else {
        const rep = floor.story !== null ? singleRewriteByStory.get(floor.story) : undefined
        const repRoot = rep !== undefined ? (rootOf.get(rep) ?? rep) : undefined
        const preferNonSeededOwnTurn = repRoot !== undefined
          && seededByNativeTurn.has(repRoot)
          && floor.story > repRoot
          && nonSeededPlayerReplyTurns.has(floor.story)
          && !claimedOrigins.has(floor.story)
          && (() => {
            let remainingUnanchored = 0
            for (let i = segIdx; i < assistantSegments.length; i++) {
              const f = assistantSegments[i].floor
              if (f.anchorTurn === null && !f.greeting) remainingUnanchored++
            }
            let unclaimedNonSeeded = 0
            for (const t of nonSeededPlayerReplyTurns) {
              if (t > repRoot && !claimedOrigins.has(t)) unclaimedNonSeeded++
            }
            return remainingUnanchored <= unclaimedNonSeeded
          })()
        if (repRoot !== undefined && !claimedOrigins.has(repRoot) && !usedRewrites.has(repRoot) && !preferNonSeededOwnTurn) {
          usedRewrites.add(repRoot)
          replyOrigin = repRoot
          inputOrigin = seededByNativeTurn.has(repRoot) || inputTurns.has(repRoot) ? repRoot : floor.story
        } else {
          const fallbackRoot = floor.story !== null ? (rootOf.get(floor.story) ?? floor.story) : null
          replyOrigin = fallbackRoot
          inputOrigin = floor.story
        }
      }

      floor.replyOrigin = replyOrigin
      floor.inputOrigin = inputOrigin
      floor.boundOrigin = inputOrigin
      if (replyOrigin !== null) {
        if (latestReplyOfRoot.has(replyOrigin)) {
          floor.boundReply = latestReplyOfRoot.get(replyOrigin)
        } else if (floor.anchorTurn === null && floor.story !== null && storyMovedTo.has(floor.story)) {
          floor.boundReply = storyMovedTo.get(floor.story)
        } else {
          floor.boundReply = replyOrigin
        }
      }

      if (
        (inputOrigin !== null && seededByNativeTurn.has(inputOrigin)) ||
        (replyOrigin !== null && (seededPairedOrigins.has(replyOrigin) || repairedReplyOrigins.has(replyOrigin)))
      ) {
        lastSeededSegmentIdx = segIdx
      }

      // 将本段紧贴在助手前的 user 配对规则与 chatRounds 对齐：
      // 最后一条 user 仅当无显式轮号、或者轮号与助手一致时配给当前助手；其余均作为未配对 standalone。
      let pairedUser = null
      let leftoverUsers = users
      if (users.length > 0) {
        const lastUser = users[users.length - 1]
        if (lastUser.explicitStory === null || floor.story === null || lastUser.explicitStory === floor.story) {
          pairedUser = lastUser
          leftoverUsers = users.slice(0, -1)
        }
      }
      if (pairedUser) {
        floor.hasPairedInput = true
        if (floor.inputOrigin !== null) pairedOrigins.add(floor.inputOrigin)
      }
      if (floor.openingInput && floor.inputOrigin !== null) {
        openingOrigins.add(floor.inputOrigin)
      }

      // 统计本段内多余 standalone 用户：无轮号计入当前助手前置附着数，有轮号按故事轮号统计。
      let untaggedCount = 0
      for (const user of leftoverUsers) {
        if (user.explicitStory !== null) {
          explicitStandaloneCounts.set(user.explicitStory, (explicitStandaloneCounts.get(user.explicitStory) || 0) + 1)
          dirty.add(user.explicitStory)
        } else {
          untaggedCount++
        }
      }
      floor.untaggedStandaloneBefore = untaggedCount
      linkFloorBindings(floor, true)
    }

    let tailUntagged = 0
    for (const user of tailUsers) {
      if (user.explicitStory !== null) {
        explicitStandaloneCounts.set(user.explicitStory, (explicitStandaloneCounts.get(user.explicitStory) || 0) + 1)
        dirty.add(user.explicitStory)
      } else {
        tailUntagged++
      }
    }

    // 在最后一个已播种/修复的助手楼层之后，若有接档的普通助手楼层则取其前置未标记 standalone 数量，
    // 否则取末尾残余无轮号用户数量，避免分叉尾部遇普通轮失败重试时误清空挂靠。
    if (lastSeededSegmentIdx + 1 < assistantSegments.length) {
      afterSeededUntaggedCount = assistantSegments[lastSeededSegmentIdx + 1].floor.untaggedStandaloneBefore
    } else {
      afterSeededUntaggedCount = tailUntagged
    }

    for (const turn of pairedOrigins) dirty.add(turn)
    for (const turn of openingOrigins) dirty.add(turn)
    for (const turn of explicitStandaloneCounts.keys()) dirty.add(turn)
    markAllSeededDirty()
  }

  function flushStep(key) {
    const rewrites = pending.get(key)
    pending.delete(key)
    const count = stepReplies.get(key) || 0
    stepReplies.delete(key)
    if (!rewrites || !rewrites.length) return
    if (count === 1) {
      const { story, turn } = rewrites[0]
      singleRewriteByStory.set(story, turn)
      if (!seededByNativeTurn.has(turn)) {
        singleRewriteTurnToStory.set(turn, story)
      }
      dirty.add(turn)
      dirty.add(story)
      floorRevision++
    } else {
      for (const item of rewrites) {
        multiRoundRepairTurns.add(item.turn)
        dirty.add(item.turn)
      }
      floorRevision++
    }
  }

  function bindPairedSeededRound(rec, assistantTurn, storyHint) {
    if (!rec) return
    rec.paired = true
    rec.ownerOrigin = assistantTurn
    if (!rec.story && Number.isSafeInteger(storyHint) && storyHint > 0) rec.story = storyHint
    seededPairedOrigins.add(assistantTurn)
    dirty.add(assistantTurn)
    dirty.add(rec.nativeTurn)
  }

  function attachPendingStandaloneToOrigin(ownerOrigin) {
    if (!pendingSeededStandalone.length) return
    const total = pendingSeededStandalone.length
    for (let index = 0; index < total; index++) {
      const rec = pendingSeededStandalone[index]
      rec.role = 'attachedStandalone'
      rec.attachedOrigin = ownerOrigin
      rec.attachedOffset = total - 1 - index
      dirty.add(rec.nativeTurn)
    }
    pendingSeededStandalone = []
  }

  function promotePendingStandaloneToTail() {
    if (!pendingSeededStandalone.length) return
    for (const rec of pendingSeededStandalone) {
      rec.role = 'tailStandalone'
      unattachedTailStandalone.push(rec)
      dirty.add(rec.nativeTurn)
    }
    pendingSeededStandalone = []
  }

  function supersedeRange(range, event) {
    const start = Number(range.start)
    const end = Number(range.end)
    if (!Number.isFinite(start) || !Number.isFinite(end)) return
    const preserve = isPreservingUserEditReplace(event, range)
    if (preserve === 'compaction') return
    if (preserve === 'user-edit') {
      const seededHit = seededBySeq.get(start)
      if (seededHit) {
        seededBySeq.delete(start)
        seededHit.seq = event.seq
        seededBySeq.set(event.seq, seededHit)
        dirty.add(seededHit.nativeTurn)
      }
      const pTurn = playerTurnBySeq.get(start)
      if (pTurn !== undefined) {
        playerTurnBySeq.delete(start)
        const set = playerInputSeqsByTurn.get(pTurn)
        if (set) { set.delete(start); set.add(event.seq) }
        playerTurnBySeq.set(event.seq, pTurn)
      }
      if (inputSeq === start) inputSeq = event.seq
      return
    }
    for (const rec of seededRecords) {
      if (rec.superseded || rec.seq === event.seq) continue
      if (start <= rec.seq && rec.seq <= end) {
        rec.superseded = true
        dirty.add(rec.nativeTurn)
      }
    }
    for (const [pSeq, pTurn] of [...playerTurnBySeq.entries()]) {
      if (pSeq === event.seq) continue
      if (start <= pSeq && pSeq <= end) {
        playerTurnBySeq.delete(pSeq)
        const set = playerInputSeqsByTurn.get(pTurn)
        if (set) {
          set.delete(pSeq)
          if (set.size === 0) {
            playerInputSeqsByTurn.delete(pTurn)
            erasedPlayerInputTurns.add(pTurn)
            dirty.add(pTurn)
          }
        }
      }
    }
  }

  /** Fold log events from index `from` (events[i].seq === i for a session log). */
  function addEvents(events, from = folded + 1) {
    // A log, or a tail of one: seqs are contiguous, so an event sits at seq - first seq.
    const offset = Number.isSafeInteger(events[0]?.seq) ? events[0].seq : 0
    const eventAt = seq => (events[seq - offset]?.seq === seq ? events[seq - offset] : undefined)
    let needsRecompute = false
    const startRevision = floorRevision
    for (let index = Math.max(0, from); index < events.length; index++) {
      const event = events[index]
      folded = index
      if (!event) continue
      const eventTurn = validPositiveTurn(event.data?.turn) ?? last
      if (Number.isSafeInteger(event.seq) && eventTurn !== null) {
        turnBySeq.set(event.seq, eventTurn)
      }
      if (event.type === 'turn/start') {
        // 如果上一轮的 pendingSeededRound 从未真正等来 assistant/message，不能把未消费的 standalone 清空丢失；
        // 把未写入回复的半成品 user 转归 tail/explicit 池，保持排队中的 standalone 不被吞掉。
        if (pendingSeededRound) {
          const orphanUser = pendingSeededRound.userRec
          pendingSeededRound = null
          if (orphanUser) {
            if (orphanUser.story !== null) {
              orphanUser.role = 'explicitStandalone'
              let list = seededExplicitByStory.get(orphanUser.story)
              if (!list) seededExplicitByStory.set(orphanUser.story, list = [])
              list.push(orphanUser)
            } else {
              orphanUser.role = 'pendingStandalone'
              pendingSeededStandalone.push(orphanUser)
            }
            dirty.add(orphanUser.nativeTurn)
          }
        }
        // A player's message queued before its turn starts (the inbox splices it in) opens it.
        if (last !== null) dirty.add(last)
        last = Number(event.data?.turn); running = true; playerInput = queuedInput; queuedInput = false; ended = ''
        inputSeq = playerInput ? queuedSeq : null; queuedSeq = null
        if (playerInput) {
          inputTurns.add(last)
          erasedPlayerInputTurns.delete(last)
          if (Number.isSafeInteger(inputSeq)) {
            let set = playerInputSeqsByTurn.get(last)
            if (!set) playerInputSeqsByTurn.set(last, set = new Set())
            set.add(inputSeq)
            playerTurnBySeq.set(inputSeq, last)
          }
        }
        if (Number.isSafeInteger(event.seq)) turnBySeq.set(event.seq, last)
        if (!turns.has(last)) { turns.add(last); dirty.add(last) }
        continue
      }
      if (event.type === 'turn/end') {
        if (pendingSeededRound) {
          const orphanUser = pendingSeededRound.userRec
          pendingSeededRound = null
          if (orphanUser) {
            if (orphanUser.story !== null) {
              orphanUser.role = 'explicitStandalone'
              let list = seededExplicitByStory.get(orphanUser.story)
              if (!list) seededExplicitByStory.set(orphanUser.story, list = [])
              list.push(orphanUser)
            } else {
              orphanUser.role = 'pendingStandalone'
              pendingSeededStandalone.push(orphanUser)
            }
            dirty.add(orphanUser.nativeTurn)
          }
        }
        running = false
        ended = String(event.data?.reason?.kind || '')
        for (const key of [...pending.keys()]) if (key.startsWith(event.data?.turn + ':')) flushStep(key)
        continue
      }
      if (event.type === 'step/end') {
        flushStep(event.data?.turn + ':' + event.data?.step)
        continue
      }

      // 除 compaction 摘要与玩家纯文本原地编辑外的任意 replace 均会抹除覆盖区间内旧的用户表面节点，
      // 对 seeded 与原生用户追踪及时置位 superseded，杜绝已删除历史在同轮号下幽灵复活。
      if (event.surfaceOp?.op === 'replace') {
        const range = surfaceReplacementRange(event.surfaceOp)
        supersedeRange(range, event)
        if (event.type === 'user/message') {
          if (isPlayerInput(event) && running && last !== null) {
            playerInput = true; inputSeq = event.seq; inputTurns.add(last); erasedPlayerInputTurns.delete(last)
            let set = playerInputSeqsByTurn.get(last)
            if (!set) playerInputSeqsByTurn.set(last, set = new Set())
            set.add(event.seq)
            playerTurnBySeq.set(event.seq, last)
            dirty.add(last)
          }
          continue
        }
      }

      if (event.type === 'user/message') {
        if (isPlayerInput(event)) {
          if (running) {
            playerInput = true; inputSeq = event.seq; inputTurns.add(last); erasedPlayerInputTurns.delete(last)
            let set = playerInputSeqsByTurn.get(last)
            if (!set) playerInputSeqsByTurn.set(last, set = new Set())
            set.add(event.seq)
            playerTurnBySeq.set(event.seq, last)
            dirty.add(last)
          } else {
            queuedInput = true; queuedSeq = event.seq
          }
          continue
        }
        if (isSeededInput(event) && last !== null) {
          const explicitStory = validPositiveTurn(event.data.source.repair.storyTurn)
          const rec = {
            seq: event.seq,
            nativeTurn: last,
            standalone: event.data.source.repair.standalone === true,
            story: explicitStory,
            paired: false,
            ownerOrigin: null,
            attachedOrigin: null,
            attachedOffset: 0,
            role: 'pending',
            superseded: false,
          }
          seededRecords.push(rec)
          if (Number.isSafeInteger(event.seq)) seededBySeq.set(event.seq, rec)
          let byTurn = seededByNativeTurn.get(last)
          if (!byTurn) seededByNativeTurn.set(last, byTurn = [])
          byTurn.push(rec)
          dirty.add(last)
          if (rec.standalone) {
            if (rec.story !== null) {
              rec.role = 'explicitStandalone'
              let list = seededExplicitByStory.get(rec.story)
              if (!list) seededExplicitByStory.set(rec.story, list = [])
              list.push(rec)
            } else {
              rec.role = 'pendingStandalone'
              pendingSeededStandalone.push(rec)
            }
          } else {
            pendingSeededRound = { nativeTurn: last, story: rec.story, userRec: rec }
          }
          needsRecompute = true
        }
        continue
      }

      if (event.type !== 'assistant/message') continue
      if (event.surfaceOp?.op === 'replace') {
        const range = surfaceReplacementRange(event.surfaceOp)
        for (const [seq, turn] of gameReplies) if (seq >= range.start && seq <= range.end) {
          gameReplies.delete(seq); dirty.add(turn)
        }
      }
      if (isAppendReply(event) && String(event.data?.message?.id || '').startsWith('tavern-game-mode:') && textOf(event.data.message)) {
        const turn = Number(event.data.turn)
        gameReplies.set(event.seq, turn); dirty.add(turn)
      }

      const story = storyOf(event)
      const assistantTurn = validPositiveTurn(event.data?.turn)
      const repairSource = event.data?.message?.source
      const isNativeRepair = repairSource?.provider === 'dsh-tavern' && repairSource?.model === 'native-repair'
      const nonEmptyText = textOf(event.data?.message) !== ''

      if (assistantTurn !== null) {
        if (pendingSeededRound && pendingSeededRound.nativeTurn === assistantTurn) {
          const round = pendingSeededRound
          pendingSeededRound = null
          bindPairedSeededRound(round.userRec, assistantTurn, story)
          if (pendingSeededStandalone.length > 0) {
            attachPendingStandaloneToOrigin(assistantTurn)
          }
          if (isNativeRepair && nonEmptyText) repairedReplyOrigins.add(assistantTurn)
          needsRecompute = true
        } else if (pendingSeededStandalone.length > 0 && nonEmptyText) {
          if (isNativeRepair) {
            attachPendingStandaloneToOrigin(assistantTurn)
            repairedReplyOrigins.add(assistantTurn)
            needsRecompute = true
          } else if (playerInput) {
            // 普通玩家对话接续在尾部悬空 standalone 之后：把它们转入 tailStandalone 视图对照计数，
            // 若当前轮最终失败未落盘仍能在重试与后继成功轮中准确留存。
            promotePendingStandaloneToTail()
            needsRecompute = true
          }
        } else if (isNativeRepair && nonEmptyText) {
          repairedReplyOrigins.add(assistantTurn)
          needsRecompute = true
        }
      }

      // A rollback replaces the model's surface from a round's input on: when that covers
      // the last turn's player input, the turn is rolled back, not failed and awaiting retry.
      if (event.surfaceOp?.op === 'replace' && !(story > 0) && Number.isSafeInteger(inputSeq)) {
        const range = surfaceReplacementRange(event.surfaceOp)
        if (Number(range.start) <= inputSeq && inputSeq <= Number(range.end)) { playerInput = false; if (last !== null) dirty.add(last) }
      }

      if (isAppendReply(event)) {
        if (!nonEmptyText) continue
        if (Number.isSafeInteger(event.seq) && assistantTurn !== null) {
          const root = rootOf.get(assistantTurn) ?? assistantTurn
          seqOriginTurn.set(event.seq, root)
          seqDrawnTurn.set(event.seq, assistantTurn)
        }
        const key = stepKey(event)
        stepReplies.set(key, (stepReplies.get(key) || 0) + 1)
        // 仅写入了显式 tavernStoryTurn 的 repair/rewrite 需要待 step 结束判断是一轮一绘还是多轮同 step；
        // 普通玩家新回合（无 story）绝不得覆写任何先前已分配 story 的绘制位置。
        if (Number.isSafeInteger(story) && story > 0 && assistantTurn !== null) {
          if (!pending.has(key)) pending.set(key, [])
          pending.get(key).push({ story, turn: assistantTurn })
        } else if (assistantTurn !== null && !isNativeRepair && !seededByNativeTurn.has(assistantTurn) && inputTurns.has(assistantTurn)) {
          nonSeededPlayerReplyTurns.add(assistantTurn)
        }
        continue
      }

      if (!Number.isSafeInteger(story) || story < 1 || event.surfaceOp?.op !== 'replace') continue
      // Native repair can replace a span containing many unrelated rounds. Its first
      // rewrite keeps that round's existing drawable row; later appends are assigned by
      // flushStep. Applying the regeneration range-tail rule here can bind the opening
      // to an arbitrary reply that merely happens to be the span's last append.
      if (isNativeRepair) continue

      const range = surfaceReplacementRange(event.surfaceOp)
      const startSeq = Number(range.start)
      const endSeq = Number(range.end)
      const end = eventAt(endSeq)
      let targetTurn = null
      if (isAppendReply(end)) targetTurn = validPositiveTurn(end.data?.turn)
      else {
        for (let seq = endSeq; seq >= startSeq; seq--) {
          const source = eventAt(seq)
          if (isAppendReply(source) && textOf(source.data?.message) !== '' && validPositiveTurn(source.data?.turn) !== null) {
            targetTurn = validPositiveTurn(source.data.turn)
            break
          }
        }
      }

      // 通过 range.start 回溯被本次重摇替换的真实根原生轮，更新以根原生轮为准的映射链路。
      const rawOriginTurn = seqOriginTurn.get(startSeq) ?? turnBySeq.get(startSeq) ?? null
      const resolvedOrigin = rawOriginTurn !== null ? (rootOf.get(rawOriginTurn) ?? rawOriginTurn) : null
      if (targetTurn === null && rawOriginTurn !== null) {
        targetTurn = seqDrawnTurn.get(startSeq) ?? resolvedOrigin
      }
      if (resolvedOrigin !== null && targetTurn !== null) {
        rootOf.set(resolvedOrigin, resolvedOrigin)
        rootOf.set(targetTurn, resolvedOrigin)
        latestReplyOfRoot.set(resolvedOrigin, targetTurn)
        if (Number.isSafeInteger(event.seq)) {
          seqOriginTurn.set(event.seq, resolvedOrigin)
          seqDrawnTurn.set(event.seq, targetTurn)
        }
        markOriginChainDirty(resolvedOrigin)
        needsRecompute = true
      }
      // 保留无锚点旧存档（以及外部手写仅传切片测试）下的 story 回fallback 映射。
      const fallbackDrawn = targetTurn ?? resolvedOrigin ?? story
      storyMovedTo.set(story, fallbackDrawn)
      dirty.add(story)
      needsRecompute = true
    }

    if (needsRecompute || floorRevision !== startRevision) {
      if (floors.length > 0) recomputeFloorBindings()
    }
  }

  /** Replace the save's floors from `from` on (later floors are dropped) with `rows`. */
  function setFloors(from, rows) {
    const start = Math.max(0, Math.min(from, floors.length))
    for (let index = floors.length - 1; index >= start; index--) {
      linkFloorBindings(floors[index], false)
      floors.pop()
    }
    for (const row of rows) {
      const explicitTurn = row?.role === 'user' ? validPositiveTurn(row.turn) : null
      const anchorTurn = row?.role === 'assistant' ? validPositiveTurn(row?.nativeTurn ?? row?.nativeAnchor?.turn) : null
      floors.push({
        role: row?.role,
        rawTurn: row?.turn,
        greeting: row?.greeting === true,
        openingInput: row?.role === 'assistant' && row.greeting === true && row.openingInputDeleted !== true,
        explicitStory: explicitTurn,
        anchorTurn,
        story: null,
        hasPairedInput: false,
        untaggedStandaloneBefore: 0,
        inputOrigin: null,
        replyOrigin: null,
        boundOrigin: null,
        boundReply: null,
      })
    }
    floorRevision++
    recomputeFloorBindings()
  }

  // The native turn the save does not hold but the page must keep, as the host draws it:
  // one still running, or the last one when it failed or was stopped with a player's
  // input in it (its error and retry live there). A round is saved before its turn ends,
  // so a completed turn the save lacks was rolled back; one the save missed (#196) is
  // adopted shortly and shows then.
  function currentOpen() {
    if (last === null) return null
    if (running) return last
    return playerInput && ended !== 'completed' && !originFloors.has(last) && !replyFloors.has(last) ? last : null
  }
  /** A regeneration under way: the native turns whose old reply it replaces. */
  function setRegeneration({ replacing: turnsReplaced = [], inProgress = false } = {}) {
    const next = new Set(turnsReplaced.map(Number).filter(turn => Number.isSafeInteger(turn) && turn >= 0))
    for (const turn of new Set([...replacing, ...next])) dirty.add(turn)
    if (last !== null) dirty.add(last)
    replacing = next; regenerating = inProgress === true
  }
  /** Turns whose player input stays visible although the round's reply is drawn elsewhere. */
  function setKeepInput(turns = []) {
    const next = new Set((Array.isArray(turns) ? turns : []).map(Number).filter(turn => Number.isSafeInteger(turn) && turn > 0))
    for (const turn of new Set([...keepInput, ...next])) dirty.add(turn)
    keepInput = next
  }
  // The story round a regeneration attempt is writing: the round its replacing turn drew,
  // or the single turn the save says is being replaced. Naming it lets the page tell
  // "the old body moved to the attempt" apart from "nothing draws this round any more".
  function replacingStoryOf(turn) {
    const current = Number(turn)
    for (const candidate of replacing) {
      if (Number(candidate) === current) continue
      const floorsDrawn = replyFloors.get(Number(candidate)) || originFloors.get(Number(candidate))
      if (floorsDrawn?.size) {
        const stories = [...floorsDrawn].map(f => f.story).filter(s => Number.isSafeInteger(s) && s > 0)
        if (stories.length) return Math.max(...stories)
      }
    }
    const candidates = [...replacing].filter(candidate => Number(candidate) !== current)
    return candidates.length === 1 ? Number(candidates[0]) : 0
  }

  function seededRecordVisible(rec) {
    if (rec.superseded) return false
    if (rec.paired) {
      if (originFloors.has(rec.ownerOrigin)) {
        return pairedOrigins.has(rec.ownerOrigin) || openingOrigins.has(rec.ownerOrigin)
      }
      // 孤立退化场景：seeded 轮配对的助手回复已在存档中被单删、但该故事轮号的独立用户消息仍留在存档里。
      if (rec.story === null) return false
      return explicitSeededRecordVisible(rec)
    }
    if (rec.role === 'attachedStandalone' && Number.isSafeInteger(rec.attachedOrigin)) {
      const boundSet = originFloors.get(rec.attachedOrigin)
      if (!boundSet?.size) return false
      let untagged = 0
      for (const floor of boundSet) untagged += floor.untaggedStandaloneBefore
      return untagged >= 1 + rec.attachedOffset
    }
    if (rec.role === 'explicitStandalone' && rec.story !== null) {
      return explicitSeededRecordVisible(rec)
    }
    if (rec.role === 'pendingStandalone' || rec.role === 'tailStandalone') {
      // 尚未挂靠的尾部 standalone 统一对照分叉最后一段后的待分配无轮号用户数量，保留写入后顺序偏移。
      const queue = [...unattachedTailStandalone, ...pendingSeededStandalone].filter(item => !item.superseded)
      const index = queue.indexOf(rec)
      if (index < 0) return false
      const offset = queue.length - 1 - index
      return afterSeededUntaggedCount >= 1 + offset
    }
    return false
  }

  function explicitSeededRecordVisible(rec) {
    const story = rec.story
    const saveCount = explicitStandaloneCounts.get(story) || 0
    if (saveCount <= 0) return false
    // 汇总同一 story 下当前所有未失效且尚未被成对助手消化的 seeded 记录（保持写入先后序，尾部优先留存）。
    const pool = []
    for (const item of seededExplicitByStory.get(story) || []) {
      if (!item.superseded) pool.push(item)
    }
    for (const item of seededRecords) {
      if (!item.superseded && item.paired && item.story === story && !originFloors.has(item.ownerOrigin) && !pool.includes(item)) {
        pool.push(item)
      }
    }
    const index = pool.indexOf(rec)
    if (index < 0) return false
    const offset = pool.length - 1 - index
    return saveCount >= 1 + offset
  }

  function seededInputVisible(turn) {
    const recs = seededByNativeTurn.get(turn)
    if (!recs?.length) return false
    for (const rec of recs) {
      if (seededRecordVisible(rec)) return true
    }
    return false
  }

  function nativeTurnHasInput(turn) {
    if (seededByNativeTurn.has(turn)) return seededInputVisible(turn)
    if (openingOrigins.has(turn) || pairedOrigins.has(turn)) return true
    // 非 seeded 普通原生轮删掉了助手回复、保留带显式 turn 的孤立用户输入时仍继续展示。
    if (inputTurns.has(turn) && !erasedPlayerInputTurns.has(turn)) {
      const total = explicitStandaloneCounts.get(turn) || 0
      if (total > 0) {
        const activeSeededExplicit = (seededExplicitByStory.get(turn) || []).filter(item => !item.superseded).length
        if (total > activeSeededExplicit) return true
      }
    }
    return false
  }

  function classify(turn) {
    if ([...gameReplies.values()].includes(turn)) return { input: 0, reply: 1 }
    // A regeneration's attempt (the save says one is under way) has no player's input,
    // only the host's trigger card: show its reply alone, while it runs and until its
    // body is drawn as the round's. Outside a regeneration a running turn shows as drawn:
    // the log does not always mark the player's input as such.
    const attempt = regenerating && turn === last && !playerInput && (turn === open || !originFloors.has(turn) && !replyFloors.has(turn))
    // The attempt draws the replaced round's new body: say which round, so a page that has
    // already shown the old body knows this is a move and may take the old row away.
    if (attempt) {
      const story = replacingStoryOf(turn)
      return story > 0 && story !== turn ? { input: 0, reply: 1, story } : { input: 0, reply: 1 }
    }
    if (turn === open) return undefined
    // The old reply a regeneration is replacing: the round shows its input only, so the
    // page does not read as two replies or as a regeneration that did nothing. The save
    // may hold the round out while it regenerates: the player's input still shows.
    if (replacing.has(turn)) {
      const keep = seededByNativeTurn.has(turn)
        ? seededInputVisible(turn)
        : (nativeTurnHasInput(turn) || (inputTurns.has(turn) && !erasedPlayerInputTurns.has(turn)))
      return { input: keep ? 1 : 0, reply: 0 }
    }
    // A failed turn's player input adopted by a retry: the round's reply is drawn in
    // another native turn, but hiding this turn whole would take the player's own words
    // with it. Draw his message only; the residue and trigger card stay hidden.
    if (keepInput.has(turn) && !originFloors.has(turn) && !replyFloors.has(turn)) return { input: 1, reply: 0, kept: 1 }

    const input = nativeTurnHasInput(turn)
    const drawnFloors = replyFloors.get(turn)
    const reply = Boolean(drawnFloors?.size)
    let story = turn
    if (reply) {
      let maxStory = -1
      for (const floor of drawnFloors) {
        if (Number.isSafeInteger(floor.story) && floor.story > maxStory) maxStory = floor.story
      }
      if (maxStory > 0) story = maxStory
    }
    if (!input && !reply && !turns.has(turn)) return undefined
    if (input && reply && story === turn) return undefined
    return { input: input ? 1 : 0, reply: reply ? 1 : 0, ...(reply && story !== turn ? { story } : {}) }
  }
  /** The plan as an immutable turn-keyed map; unchanged turns keep their identity. */
  function result() {
    const next = currentOpen()
    if (next !== open) { if (open !== null) dirty.add(open); if (next !== null) dirty.add(next); open = next }
    if (dirty.size) {
      const sets = [], removes = []
      for (const turn of dirty) {
        if (!Number.isSafeInteger(turn) || turn < 0) continue
        const value = classify(turn)
        if (value === undefined) removes.push(turn)
        else sets.push([turn, value])
      }
      dirty.clear()
      exceptions = turnFields.update(exceptions, sets, removes)
    }
    return exceptions
  }
  return { addEvents, setFloors, setRegeneration, setKeepInput, result, get floorCount() { return floors.length }, get folded() { return folded }, get open() { result(); return open } }
}

const floorOf = message => {
  const nativeTurn = validPositiveTurn(message?.nativeAnchor?.turn ?? message?.nativeTurn)
  return {
    role: message?.role,
    turn: message?.turn,
    greeting: message?.greeting,
    ...(message?.openingInputDeleted === true ? { openingInputDeleted: true } : {}),
    ...(nativeTurn !== null ? { nativeTurn } : {}),
  }
}

/**
 * The plan for what a view holds: its save floors (the whole history, or the bounded
 * window long games are shown with) and the log from the turn the first of those rounds
 * began. The cost follows the window, never the length of the game: native turns before
 * the window's first round are not judged (`from`), and the page leaves them as the host
 * draws them until scrolling brings them into a wider window.
 * @returns {{ turns: object, from: number | null }}
 */
export function planTranscriptWindow({ messages = [], events = [], partial = false, regeneration, keepInput }) {
  const fold = createTranscriptFold()
  fold.setFloors(0, messages.map(floorOf))
  if (!partial) { fold.addEvents(events, 0); fold.setRegeneration(regeneration); fold.setKeepInput(keepInput); return { turns: fold.result(), from: null } }

  // 先解析窗口消息所需的最小已知原生轮边界（nativeAnchor.turn）、输入关联 seq、
  // 未带原生锚点的故事轮集合，以及落在第一条助手之前的前置 standalone 需求数量。
  let anchoredMinTurn = Number.MAX_SAFE_INTEGER
  let minNeededSeq = Number.MAX_SAFE_INTEGER
  const windowStories = new Set()
  const unanchoredStories = new Set()
  let firstAssistantSeen = false
  let prefixUntaggedUsers = 0
  const prefixExplicitStories = new Set()
  let lastPrefixUser = null

  for (const message of messages) {
    if (!message) continue
    if (message.role === 'user') {
      const explicitTurn = validPositiveTurn(message.turn)
      if (!firstAssistantSeen) {
        if (lastPrefixUser) {
          if (lastPrefixUser.explicitTurn !== null) prefixExplicitStories.add(lastPrefixUser.explicitTurn)
          else prefixUntaggedUsers++
        }
        lastPrefixUser = { explicitTurn }
      }
      if (explicitTurn !== null) windowStories.add(explicitTurn)
      continue
    }
    if (message.role !== 'assistant') continue
    const mStory = validPositiveTurn(message.turn)
    if (mStory !== null) windowStories.add(mStory)
    if (!firstAssistantSeen) {
      firstAssistantSeen = true
      if (lastPrefixUser) {
        if (lastPrefixUser.explicitTurn !== null && mStory !== null && lastPrefixUser.explicitTurn !== mStory) {
          prefixExplicitStories.add(lastPrefixUser.explicitTurn)
        }
        lastPrefixUser = null
      }
    }
    const anchorTurn = validPositiveTurn(message?.nativeAnchor?.turn ?? message?.nativeTurn)
    if (anchorTurn !== null) {
      anchoredMinTurn = Math.min(anchoredMinTurn, anchorTurn)
      const anchorInput = Number(message?.nativeAnchor?.input)
      if (Number.isSafeInteger(anchorInput) && anchorInput >= 0) minNeededSeq = Math.min(minNeededSeq, anchorInput)
    } else if (mStory !== null) {
      unanchoredStories.add(mStory)
    }
  }
  if (lastPrefixUser) {
    if (lastPrefixUser.explicitTurn !== null) prefixExplicitStories.add(lastPrefixUser.explicitTurn)
    else prefixUntaggedUsers++
  }

  let requiredTurn = anchoredMinTurn < Number.MAX_SAFE_INTEGER ? anchoredMinTurn : Number.MAX_SAFE_INTEGER
  if (unanchoredStories.size > 0) {
    requiredTurn = Math.min(requiredTurn, ...unanchoredStories)
  }
  for (const s of prefixExplicitStories) windowStories.add(s)

  // 从后向前扫描日志至覆盖全部锚定边界、跨轮替换 source seq 以及无锚前置重修轮；
  // 遇到边界后仍顺带吸收紧随前一 turn/end 之后入队的玩家 queued user/message，但绝不丢弃真实 native turn 坐标。
  let start = events.length
  let from = null
  let committedTarget = false
  let remainingPrefixUntagged = prefixUntaggedUsers
  let sawSeededStandalone = false

  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (!event) continue
    if (event.type === 'user/message' && event.data?.source?.repair?.seeded === true && event.data?.source?.repair?.standalone === true) {
      sawSeededStandalone = true
      const sTurn = validPositiveTurn(event.data.source.repair.storyTurn)
      if (sTurn !== null && prefixExplicitStories.has(sTurn)) {
        prefixExplicitStories.delete(sTurn)
      }
    }

    if (event.type === 'assistant/message') {
      const mTurn = validPositiveTurn(event.data?.turn)
      const mStory = storyOf(event)
      if (mStory !== null && unanchoredStories.has(mStory) && mTurn !== null) {
        requiredTurn = Math.min(requiredTurn, mTurn)
      }
      if (event.surfaceOp?.op === 'replace') {
        const range = surfaceReplacementRange(event.surfaceOp)
        const rStart = Number(range.start)
        const isRepair = event.data?.message?.source?.provider === 'dsh-tavern' && event.data?.message?.source?.model === 'native-repair'
        // 当重摇替换或影响窗口内的任何故事轮、或从当前已知起点之后发生替换时，把被替换节点 seq 纳入追溯下界。
        if (Number.isFinite(rStart) && !isRepair && (windowStories.has(mStory) || (mTurn !== null && mTurn >= requiredTurn) || requiredTurn === Number.MAX_SAFE_INTEGER)) {
          minNeededSeq = Math.min(minNeededSeq, rStart)
        }
      }
    }

    if (event.type !== 'turn/start') continue
    const turn = validPositiveTurn(event.data?.turn)
    const isStandaloneTurn = sawSeededStandalone
    sawSeededStandalone = false
    if (turn === null) continue

    const seqAtOrBeforeNeed = !Number.isFinite(minNeededSeq) || minNeededSeq === Number.MAX_SAFE_INTEGER || !Number.isSafeInteger(event.seq) || event.seq <= minNeededSeq
    const needReached = requiredTurn === Number.MAX_SAFE_INTEGER
      ? (!unanchoredStories.size && !prefixExplicitStories.size && (isStandaloneTurn || remainingPrefixUntagged <= 0))
      : (turn <= requiredTurn && seqAtOrBeforeNeed)

    if (committedTarget && remainingPrefixUntagged > 0 && !prefixExplicitStories.size && turn < requiredTurn) {
      if (isStandaloneTurn) {
        start = index
        from = turn
        remainingPrefixUntagged--
        if (remainingPrefixUntagged <= 0) break
        continue
      }
      // 左侧上一轮并非前置 standalone，停止扫描并保留先前回溯到的精确切片边界。
      break
    }

    start = index
    from = turn

    if (needReached && prefixExplicitStories.size === 0) {
      if (isStandaloneTurn && remainingPrefixUntagged > 0 && requiredTurn === Number.MAX_SAFE_INTEGER) {
        remainingPrefixUntagged--
        if (remainingPrefixUntagged <= 0) break
        committedTarget = true
        continue
      }
      if (remainingPrefixUntagged <= 0) break
      committedTarget = true
    }
  }

  for (let index = start - 1; index >= 0; index--) {
    const type = events[index]?.type
    if (type === 'turn/end' || type === 'turn/start') break
    if (type === 'user/message') start = index
  }

  const sliced = events.slice(start)
  let firstSliceTurn = null
  for (const event of sliced) {
    if (event?.type === 'turn/start') {
      firstSliceTurn = validPositiveTurn(event.data?.turn)
      if (firstSliceTurn !== null) break
    }
  }
  from = firstSliceTurn

  fold.addEvents(sliced, 0)
  fold.setRegeneration(regeneration)
  fold.setKeepInput(keepInput)
  return { turns: fold.result(), from }
}

/** The whole plan at once, for tests and the replay: the same fold fed everything. */
export function planTranscriptRows({ chat, events = [], regeneration, keepInput }) {
  const fold = createTranscriptFold()
  fold.setFloors(0, (Array.isArray(chat?.messages) ? chat.messages : []).map(floorOf))
  fold.addEvents(events, 0)
  fold.setRegeneration(regeneration)
  fold.setKeepInput(keepInput)
  return fold.result()
}

const INPUT_ROWS = new Set(['user', 'turn-trigger'])

/**
 * Whether the page shows one host row under a plan (the turn-keyed exceptions). The
 * client applies the same rule; the replay and the comparison log use this copy.
 * @param {{ turn: number | null, kind: string }} row
 */
export function planShowsRow(plan, row, from = null) {
  if (!plan || row.turn === null || row.turn === undefined) return true
  // Before a windowed plan's first round: not judged, shown as the host draws it.
  if (from !== null && Number(row.turn) < from) return true
  const entry = plan[String(row.turn)]
  if (!entry) return true
  // A kept input turn draws the player's own message and nothing else.
  if (entry.kept) return row.kind === 'user' || row.kind === 'steering'
  // Host notes (context rows) of a turn that draws nothing go with it.
  if (row.kind === 'context') return entry.input === 1 || entry.reply === 1
  // Replies, tails and errors belong to the turn that draws the round's reply; a turn
  // that only holds the input keeps the input and nothing else.
  return INPUT_ROWS.has(row.kind) ? entry.input === 1 : entry.reply === 1
}

/** The story round a native turn's reply row is drawn as, or the turn itself. */
export function planStoryTurn(plan, turn) {
  return plan?.[String(turn)]?.story ?? Number(turn)
}
