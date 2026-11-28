/**
 * 两张"等人动手"的卡：**答题卡（提问）和审批卡**（2026-11-28）。
 *
 * ## 为什么要单开一份
 *
 * 用户报的现象是「手机端弹出选择卡片时如果不在当前会话，卡片就丢了，但是会话列表还显示
 * 提问」。查下去是两条链没对齐：徽标按会话记账（进门就记，与"手机在看哪个会话"无关），
 * 而卡片只有 `agentId === bound` 时才生成。于是别的会话那道题只剩一个「待回答」，
 * 切过去、刷新都补不回来。修法有三段，这一份钉的是**页面那一段**：
 *
 *   ① 题不再因为"不是当前会话"而让路（lib/index.js 那两条钩子，plugin.test.mjs 钉着）；
 *   ② 卡片改成队列——两道同时在等时，后到的不许把前一道顶掉（这一份）；
 *   ③ 卡头上写清是哪个会话在问/要动手，并给一颗「切过去」（这一份）。
 *
 * 审批卡和答题卡是同一套机制、同一个病（同一个 `markPending` 记账、同一个让路分支），
 * 所以两份都在这一个文件里，用同一套 DOM 桩。
 *
 * ## 为什么把 `connect()` 里那一整块抠出来跑
 *
 * 这一段的判据全在**状态迁移**上（谁在卡上、谁在队里、答完谁顶上来），桩掉就等于
 * 什么也没测。所以和 page.test.mjs 那些切片同一个做法：取真源码、配一层够用的 DOM 桩。
 * 切片靠两个注释锚点，锚点对不上会立刻断言失败，不会安静地退化成空测试。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

import { pageFiles } from '../lib/page.js'

const html = readFileSync(pageFiles().app, 'utf8')

const START = '    // ——— 回答电脑的提问 ———'
const END = '    // ——— 抽屉的拖拽 / 收起 ———'
const a = html.indexOf(START)
const b = html.indexOf(END)
assert.ok(a > 0, `在 lib/page/app.js 里找不到锚点「${START}」`)
assert.ok(b > a, `在 lib/page/app.js 里找不到锚点「${END}」`)
const SLICE = html.slice(a, b)

/** 把一段 HTML 还原成它显示出来的纯文字（和真 DOM 写 innerHTML 的行为对齐）。 */
function strip(text) {
  return String(text)
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&')
}

/** 够用的元素桩：class / style / 子节点 / 监听 / innerHTML（写了就清子节点，和真 DOM 一样）。 */
function makeEl(id) {
  const el = {
    id, textContent: '', style: {}, children: [], _cls: new Set(), _on: {}, _attrs: {}, value: '',
  }
  el.classList = {
    add: (...c) => { for (const one of c) el._cls.add(one) },
    remove: (...c) => { for (const one of c) el._cls.delete(one) },
    contains: (c) => el._cls.has(c),
    toggle: (c, on) => {
      if (on === undefined) { if (el._cls.has(c)) el._cls.delete(c); else el._cls.add(c) } else if (on) el._cls.add(c)
      else el._cls.delete(c)
    },
  }
  let written = ''
  Object.defineProperty(el, 'innerHTML', {
    get: () => written,
    set: (v) => {
      written = v == null ? '' : String(v)
      if (!written) el.children = []
      el.textContent = strip(written)
    },
  })
  el.getBoundingClientRect = () => ({ height: 120 })
  el.appendChild = (c) => { el.children.push(c); return c }
  el.addEventListener = (type, fn) => { (el._on[type] || (el._on[type] = [])).push(fn) }
  // 点它：真 DOM 里事件会冒到委托的那一层，这里由用例自己把 target 递进去。
  el.click = (target) => { for (const fn of el._on.click || []) fn({ target: target || el }) }
  el.setAttribute = (k, v) => { el._attrs[k] = String(v) }
  el.getAttribute = (k) => (k in el._attrs ? el._attrs[k] : null)
  el.focus = () => {}
  return el
}

/** 把答题卡那一块从真源码里装起来，配一层够用的桩。 */
function buildAsk() {
  const ids = [
    'askCard', 'askHead', 'askText', 'askDetail', 'askOpts', 'askCustomWrap',
    'askCustom', 'askBack', 'askOwn', 'askNext',
  ]
  const els = {}
  for (const id of ids) els[id] = makeEl(id)

  const toasts = []
  const binds = []
  const remembered = []
  const state = { boundSessionId: 's1' }
  const mainEl = { style: {} }

  // eslint-disable-next-line no-new-func
  const box = new Function(
    'state', '$', 'document', 'mainEl', 'toast', 'sendAnswer', 'rememberAnswer',
    'askItems', 'bindSession', 'escapeHtml', 'askFocusOf', 'askRepaintOf',
    `${SLICE}
    return {
      ask: () => ask,
      queue: () => askQueue,
      enqueue: askEnqueue,
      fromFrame: askFromFrame,
      drop: askDrop,
      focus: askFocus,
      reconcile: reconcileAsk,
      render: askRender,
      close: closeAskCard,
    };`,
  )(
    state,
    (id) => els[id] ?? null,
    { createElement: () => makeEl('el') },
    mainEl,
    (m) => toasts.push(m),
    () => Promise.resolve('ok'),
    (...args) => remembered.push(args),
    () => [{ selected: ['A'] }],
    (id) => binds.push(id),
    (s) => String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    )),
    null,
    null,
  )
  return { ...box, els, state, toasts, binds, remembered, mainEl }
}

/** 一道题的形状（和 lib/server.js 推过来的那条帧同构）。 */
const question = (text) => [{
  id: 'x', question: text, options: [{ label: 'A' }, { label: 'B' }],
}]

const frame = (id, agentId, title, text = '选哪个') => ({
  id, agentId, sessionTitle: title, questions: question(text),
})

test('答题卡：两道题同时在等，后到的不许把前一道顶掉', () => {
  const h = buildAsk()
  h.enqueue(h.fromFrame(frame('q1', 's1', '会话一')))
  assert.equal(h.ask().id, 'q1', '第一道直接上卡')
  h.enqueue(h.fromFrame(frame('q2', 's2', '会话二')))
  assert.equal(h.ask().id, 'q1', '正在答的那张不许被顶掉')
  assert.deepEqual(h.queue().map((one) => one.id), ['q2'], '后到的排队等着')
  assert.match(h.els.askHead.textContent, /还有 1 道在等/, '队列不能是隐形的')
})

test('答题卡：同一道题再来一遍（重连补发 / 轮询兜底）不会重建', () => {
  const h = buildAsk()
  h.enqueue(h.fromFrame(frame('q1', 's1', '会话一')))
  h.els.askOpts.children[0].click()          // 勾上 A
  assert.equal(h.ask().picked[0].selected.length, 1)
  h.enqueue(h.fromFrame(frame('q1', 's1', '会话一')))
  assert.equal(h.queue().length, 0, '重复的那条不许排队')
  assert.equal(h.ask().picked[0].selected[0], 'A', '重发不能把用户勾好的选项清掉')
})

test('答题卡：答完一道，队里的下一道自己顶上来', async () => {
  const h = buildAsk()
  h.enqueue(h.fromFrame(frame('q1', 's1', '会话一')))
  h.enqueue(h.fromFrame(frame('q2', 's2', '会话二')))
  h.els.askOpts.children[0].click()
  h.els.askNext.click()
  await Promise.resolve()
  await Promise.resolve()
  assert.equal(h.ask()?.id, 'q2', '收一张要顶一张')
  assert.equal(h.els.askCard.classList.contains('on'), true, '第二张卡是亮的')
  assert.deepEqual(h.remembered[0]?.slice(0, 3), ['q1', [{ selected: ['A'] }], 'phone'], '答完那条 chip 记的是第一道')
})

test('答题卡：不是当前会话问的，头上写清是谁，并给一颗「切过去」', () => {
  const h = buildAsk()
  h.state.boundSessionId = 's1'
  h.enqueue(h.fromFrame(frame('q1', 's2', '会话二')))
  const head = h.els.askHead
  assert.match(head.textContent, /会话二/, '要说清是哪个会话在问')
  assert.match(head.innerHTML, /data-go="s2"/, '要给一个切过去的入口')
  // 点那颗按钮：走委托，target 是按钮自己。
  const btn = { closest: (sel) => (sel === '[data-go]' ? { getAttribute: () => 's2' } : null) }
  head.click(btn)
  assert.deepEqual(h.binds, ['s2'], '点了就切到那个会话')
})

test('答题卡：当前会话问的，照旧说「电脑在问你一件事」，不给「切过去」', () => {
  const h = buildAsk()
  h.state.boundSessionId = 's1'
  h.enqueue(h.fromFrame(frame('q1', 's1', '会话一')))
  assert.equal(h.els.askHead.textContent, '电脑在问你一件事')
  assert.doesNotMatch(h.els.askHead.innerHTML, /data-go/, '同一个会话里没有"切过去"这回事')
})

test('答题卡：会话名是用户自己的字，进 HTML 前要转义', () => {
  const h = buildAsk()
  h.enqueue(h.fromFrame(frame('q1', 's2', '<img src=x onerror=1>')))
  assert.doesNotMatch(h.els.askHead.innerHTML, /<img/, '不许把会话名当标签写进去')
})

test('答题卡：对账时把队里已经落定的题拿掉（不然顶上来一按就是"已过期"）', () => {
  const h = buildAsk()
  h.enqueue(h.fromFrame(frame('q1', 's1', '会话一')))
  h.enqueue(h.fromFrame(frame('q2', 's2', '会话二')))
  h.enqueue(h.fromFrame(frame('q3', 's3', '会话三')))
  // 服务端还挂着的只有 q1：另外两道在别处答完 / 被撤了。
  h.reconcile({ pending: [{ id: 'q1' }], settled: [] })
  assert.deepEqual(h.queue().map((one) => one.id), [])
  assert.equal(h.ask().id, 'q1', '还在等的那张一个字都不动')
})

test('答题卡：别处答完队里那道，只把它拿掉，不弹提示', () => {
  const h = buildAsk()
  h.enqueue(h.fromFrame(frame('q1', 's1', '会话一')))
  h.enqueue(h.fromFrame(frame('q2', 's2', '会话二')))
  h.drop('q2')
  assert.deepEqual(h.queue().map((one) => one.id), [])
  assert.deepEqual(h.toasts, [], '用户没在看那道题，不拿提示烦他')
})

test('答题卡：收起之后，队里的人数变了不许把它弹回来', () => {
  const h = buildAsk()
  h.enqueue(h.fromFrame(frame('q1', 's1', '会话一')))
  h.enqueue(h.fromFrame(frame('q2', 's2', '会话二')))
  h.els.askCard.classList.add('collapsed')   // 用户自己拖下去的
  h.drop('q2')                               // 队里少了一道，卡头要重画
  assert.equal(h.els.askCard.classList.contains('collapsed'), true,
    '收起态是用户拖的，重画一次卡头不许给他弹回来')
})

test('答题卡：点会话列表那一行，把这一行的题翻出来（当前那张不丢）', () => {
  const h = buildAsk()
  h.enqueue(h.fromFrame(frame('q1', 's1', '会话一')))
  h.enqueue(h.fromFrame(frame('q2', 's2', '会话二')))
  h.focus('s2')
  assert.equal(h.ask().id, 'q2', '点哪一行就翻哪一道')
  assert.deepEqual(h.queue().map((one) => one.id), ['q1'], '正在答的那张塞回队首，不能丢')
  // 再点一次同一个会话：收起着的顺手展开（收起态是用户自己拖的）。
  h.els.askCard.classList.add('collapsed')
  h.focus('s2')
  assert.equal(h.els.askCard.classList.contains('collapsed'), false)
})

// ---------------------------------------------------------------------------
// 接线：上面这些函数得真被那几条帧调着，不然它们只是躺在文件里的死代码
// ---------------------------------------------------------------------------

test('接线：question 帧走 askEnqueue(askFromFrame(…))，不再自己建一张卡', () => {
  assert.match(html, /es\.addEventListener\('question',[\s\S]{0,400}?askEnqueue\(askFromFrame\(payload\)\)/)
})

test('接线：question-done 对队里那道也要动手（askDrop），而且 chip 带会话号', () => {
  const body = html.slice(
    html.indexOf("es.addEventListener('question-done'"),
    html.indexOf("es.addEventListener('question-state'"),
  )
  assert.match(body, /askDrop\(payload\.id\)/, '队里那道被别处答掉时要从队里拿掉')
  assert.match(body, /payload\.agentId/, 'chip 要落回问这道题的那个会话')
})

test('接线：轮询兜底把 ping 里每一道都补进队列（不只是第一道）', () => {
  const body = html.slice(html.indexOf('function pollTick'), html.indexOf('pollTimer = setInterval'))
  assert.match(body, /for \(var i = 0; i < list\.length; i\+\+\) \{\s*askEnqueue\(askFromFrame\(list\[i\]\)\)/)
})

test('接线：导航栏点一行会问一句「这一行有没有题在等」', () => {
  const body = html.slice(html.indexOf("$('navBody').addEventListener('click'"), html.indexOf("// —— 会话条目的执行入口"))
  assert.match(body, /askFocusOf\(sid\)/)
})

// ---------------------------------------------------------------------------
// 审批卡：同一个病、同一个改法（2026-11-28）
//
// 审批是另一扇门（`approval/request`，模型要跑一条需要拍板的命令），但它和提问共用
// 同一份徽标记账、同一条「不是当前会话就让路」。所以这边也得有队列、也要点名。
// 差别只有一处：这张卡是**整屏一层**（inset:0），所以多一条「稍后」的退路——
// 别人会话的审批卡不该把用户困在屏幕前。
// ---------------------------------------------------------------------------

const APPROVE_START = '    // ——— 命令确认（审批）———'
const APPROVE_END = "    es.addEventListener('question', function (e) {"
const pa = html.indexOf(APPROVE_START)
const pb = html.indexOf(APPROVE_END)
assert.ok(pa > 0, `在 lib/page/app.js 里找不到锚点「${APPROVE_START}」`)
assert.ok(pb > pa, `在 lib/page/app.js 里找不到锚点「${APPROVE_END}」`)
const APPROVE_SLICE = html.slice(pa, pb)

/** 把审批卡那一块从真源码里装起来，配一层够用的桩。 */
function buildApprove() {
  const ids = [
    'approveCard', 'approveHead', 'approveTool', 'approveReason', 'approveCmd',
    'approveAllow', 'approveDeny',
  ]
  const els = {}
  for (const id of ids) els[id] = makeEl(id)

  const toasts = []
  const decisions = []
  const binds = []
  const state = { boundSessionId: 's1' }

  // eslint-disable-next-line no-new-func
  const box = new Function(
    'state', '$', 'document', 'toast', 'sendApproval', 'escapeHtml', 'goFromHead', 'es',
    `${APPROVE_SLICE}
    return {
      approve: () => approve,
      queue: () => approveQueue,
      enqueue: approveEnqueue,
      fromFrame: approveFromFrame,
      drop: approveDrop,
      focus: approveFocus,
      close: approveClose,
    };`,
  )(
    state,
    (id) => els[id] ?? null,
    { createElement: () => makeEl('el') },
    (m) => toasts.push(m),
    (id, allow) => { decisions.push({ id, allow }); return Promise.resolve('ok') },
    (s) => String(s).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    )),
    // 「切过去」那个处理函数和答题卡共用一个真货（见 goFromHead），这里按同样的语义
    // 做个替身——真货本身由答题卡那几条钉着。
    (e) => {
      const t = e.target
      const go = t && t.closest ? t.closest('[data-go]') : null
      if (go) binds.push(go.getAttribute('data-go'))
    },
    { addEventListener: () => {} },
  )
  return { ...box, els, state, toasts, decisions, binds }
}

const approvalFrame = (id, agentId, title) => ({
  id, agentId, sessionTitle: title, toolName: 'shell', reason: '', command: 'rm -rf build',
})

test('审批卡：两条同时在等，后到的不许把前一条顶掉', () => {
  const h = buildApprove()
  h.enqueue(h.fromFrame(approvalFrame('a1', 's1', '会话一')))
  assert.equal(h.approve().id, 'a1')
  h.enqueue(h.fromFrame(approvalFrame('a2', 's2', '会话二')))
  assert.equal(h.approve().id, 'a1', '正在拍的那条不许被顶掉')
  assert.deepEqual(h.queue().map((one) => one.id), ['a2'])
  assert.match(h.els.approveHead.textContent, /还有 1 条在等/)
})

test('审批卡：拍完一条，队里那条自己顶上来', async () => {
  const h = buildApprove()
  h.enqueue(h.fromFrame(approvalFrame('a1', 's1', '会话一')))
  h.enqueue(h.fromFrame(approvalFrame('a2', 's2', '会话二')))
  h.els.approveAllow.click()
  await Promise.resolve()
  await Promise.resolve()
  assert.deepEqual(h.decisions, [{ id: 'a1', allow: true }], '拍的是第一条')
  assert.equal(h.approve()?.id, 'a2', '拍完要顶下一条上来')
  assert.equal(h.els.approveCard.classList.contains('on'), true)
})

test('审批卡：不是当前会话要动手的，点名 + 切过去 + 留一条「稍后」的退路', () => {
  const h = buildApprove()
  h.state.boundSessionId = 's1'
  h.enqueue(h.fromFrame(approvalFrame('a1', 's2', '会话二')))
  const head = h.els.approveHead
  assert.match(head.textContent, /会话二/, '要说清是哪个会话要动手——不然就是让人盲签')
  assert.match(head.innerHTML, /data-go="s2"/, '要给一个切过去的入口')
  assert.match(head.innerHTML, /data-later/, '整屏一层，必须留一条不出手的退路')

  // 「稍后」：只把这一层收起来，**不替用户做决定**。
  head.click({ closest: (sel) => (sel === '[data-later]' ? {} : null) })
  assert.equal(h.els.approveCard.classList.contains('on'), false)
  assert.deepEqual(h.decisions, [], '「稍后」不是拒绝：一条决定都不该发出去')

  // 收起来之后靠会话列表那一行翻回来（见 approveFocus）。
  assert.equal(h.focus('s2'), true, '这一行确实有审批')
  assert.equal(h.els.approveCard.classList.contains('on'), true)
})

test('审批卡：别处拍完队里那条，只把它拿掉（当前这条不动）', () => {
  const h = buildApprove()
  h.enqueue(h.fromFrame(approvalFrame('a1', 's1', '会话一')))
  h.enqueue(h.fromFrame(approvalFrame('a2', 's2', '会话二')))
  h.drop('a2')
  assert.deepEqual(h.queue().map((one) => one.id), [])
  assert.equal(h.approve().id, 'a1')
  assert.deepEqual(h.toasts, [], '用户没在看那条，不拿提示烦他')
})

test('接线：approval 帧走 approveEnqueue(approveFromFrame(…))', () => {
  assert.match(html, /es\.addEventListener\('approval',[\s\S]{0,400}?approveEnqueue\(approveFromFrame\(payload\)\)/)
})

test('接线：approval-done 对队里那条也要动手（approveDrop）', () => {
  const body = html.slice(
    html.indexOf("es.addEventListener('approval-done'"),
    html.indexOf("es.addEventListener('status'"),
  )
  assert.match(body, /approveDrop\(payload\.id\)/)
})

test('接线：电脑上先拍完，手机那张卡要收起来并说清电脑拍的是什么', () => {
  // 2026-11-28 晚：审批改成赛跑（谁先拍谁生效）。电脑那一票由插件带 `decision` 过来，
  // 页面照实说「允许了 / 拒绝了」——只说一句"处理过了"等于让人再去电脑上确认一遍。
  const body = html.slice(
    html.indexOf("es.addEventListener('approval-done'"),
    html.indexOf("es.addEventListener('status'"),
  )
  assert.match(body, /payload\.source === 'pc'/, '电脑先拍完这条路要有')
  assert.match(body, /电脑上允许了/)
  assert.match(body, /电脑上拒绝了/)
})
