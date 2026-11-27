/**
 * 「你答过的一道题」怎么从会话事件里认出来。
 *
 * 为什么要有这个文件：历史重放（lib/history.js）和实时推送（lib/index.js）都得认这一对事件，
 * 两边各写一套判断的话，同一道问答在手机上（实时）和重开页面（重放）会一个有一个没有、
 * 或者长得不一样。这条纪律和 lib/events.js / lib/trajectory.js 开头写的那条是同一条。
 *
 * 数据来源（2026-11-27 在真机的会话日志里核对过）：
 *   tool/call    data.name === 'ask_user_question'，data.callId，arguments 里是 { questions: [...] }
 *   tool/result  data.message.toolCallId（配上前面的 callId），
 *                content 里那段文本是 {"answers":[{"id","selected":[…],"custom"?}]}
 *
 * **答题不产生 `user/message`**：`answerQuestion` 把答案直接交给工具的 `settle`
 * （见 lib/server.js），DSH 把它写成工具结果。所以没有第二个来源——`source.kind ===
 * 'user-question-reply'` 这种东西不存在，别去 events.js 里加过滤。
 *
 * 判据故意留了余地：窗口从日志尾部读，**题目的 `tool/call` 可能落在窗口外**。那时认不出
 * 工具名，就按结果正文的形状认（`answers` 是数组、每项有 `id`）。形状不对一律返回 null：
 * 被按停、出错的结果不是 JSON，宁可不画，也不能画一条凭空的「你选了」。
 */

/** 提问工具的固定名字。DSH 那边就这一个（错误文案里也是它，见 lib/index.js 的 abort 分支）。 */
export const ASK_TOOL = 'ask_user_question'

/** 记着的题目最多留这么多道；超了丢最早的（长会话里 call 多得像流水，不能无限涨）。 */
const ASK_KEEP = 200

function parseJson(text) {
  if (typeof text !== 'string' || !text) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** 工具结果里那段正文（只取 text 块，和 events.js 的 visibleText 同一个口径，但不 import 它）。 */
function resultText(message) {
  const content = message?.content
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block && block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  return parts.join('\n\n').trim()
}

/** callId 的取法：result 事件的三种写法都见过（见 lib/trajectory.js 那处配对）。 */
function callIdOf(data) {
  const message = data?.message ?? {}
  const raw = message.toolCallId ?? data?.callId ?? data?.toolCallId
  return raw === undefined || raw === null ? '' : String(raw)
}

/**
 * 「你选了哪几个、写了什么」按答案的顺序拼出来。
 *
 * 题目正文（`header` / `question`）只在**这一对事件都在窗口里**时才有——取不到就留空，
 * 界面上只显示答案本身，不编一个问题出来。
 *
 * **导出**：实时那条路（lib/server.js 的提问清单、lib/index.js 的 pc 分支）也要拼同一份
 * 形状——卡片收掉之后要立刻告诉手机「你选了 X」。三处各拼一套的话，「手机答的」和
 * 「电脑答的」会长得不一样，界面上就会一个有一个没有。
 */
export function answerItems(answers, questions) {
  const byId = new Map()
  for (const q of Array.isArray(questions) ? questions : []) {
    if (q && typeof q.id === 'string') byId.set(q.id, q)
  }
  const items = []
  for (const a of answers) {
    if (!a || typeof a !== 'object') continue
    const id = typeof a.id === 'string' ? a.id : ''
    const q = id ? byId.get(id) : null
    const selected = Array.isArray(a.selected)
      ? a.selected.filter((s) => typeof s === 'string' && s !== '')
      : []
    const custom = typeof a.custom === 'string' ? a.custom.trim() : ''
    // 两样都没有的那一题什么都不说：画一个空 chip 比不画更让人糊涂。
    if (!selected.length && !custom) continue
    items.push({
      id,
      header: typeof q?.header === 'string' ? q.header : '',
      title: typeof q?.question === 'string' ? q.question : '',
      selected,
      custom,
    })
  }
  return items
}

/**
 * 喂一条事件；命中「刚答完」时返回一条要进聊天记录的条目，否则返回 null。
 *
 * @param {{type?:string, time?:number, data?:any}} event DSH 的原始会话事件
 * @param {Map<string, any[]>} seen 同一个会话复用的那张表（callId → questions）。
 *        重放那条路每次重放一份新的；实时那条路跟着插件生命周期一直用。
 * @returns {{role:'answer', callId:string, items:Array, turn:number|null, timestamp:number|null}|null}
 */
export function askAnswerFrom(event, seen) {
  const type = event?.type
  const data = event?.data ?? {}

  if (type === 'tool/call') {
    if (data.name !== ASK_TOOL) return null
    const callId = callIdOf(data)
    if (!callId) return null
    const parsed = parseJson(typeof data.arguments === 'string' ? data.arguments : '')
    const questions = Array.isArray(parsed?.questions) ? parsed.questions : []
    seen.set(callId, questions)
    while (seen.size > ASK_KEEP) seen.delete(seen.keys().next().value)
    return null
  }

  if (type !== 'tool/result') return null
  const callId = callIdOf(data)
  if (!callId) return null
  // 失败 / 被按停的结果不是答案：`isError` 或带 `error` 的一律不认（见 lib/trajectory.js
  // 对这两个字段的同一套判断）。
  if (data.message?.isError === true) return null
  if (data.error !== undefined && data.error !== null) return null
  const parsed = parseJson(resultText(data.message))
  if (!parsed || !Array.isArray(parsed.answers)) return null
  const questions = seen.get(callId) ?? []
  seen.delete(callId)
  const items = answerItems(parsed.answers, questions)
  if (!items.length) return null
  return {
    role: 'answer',
    callId,
    items,
    turn: typeof data.turn === 'number' ? data.turn : null,
    // 时间戳用事件自己的 `time`：重放和实时两边同一个钟，store 按时间戳合成时才认得出
    // 「这条已经有了」，不会接成两条（理由见 lib/store.js 的 mergeHistory）。
    timestamp: typeof event?.time === 'number' ? event.time : null,
  }
}
