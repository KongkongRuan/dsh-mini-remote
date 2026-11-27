/**
 * 手机页的传输层：压缩、ETag/304、缓存头。
 *
 * ## 为什么单独一个文件
 *
 * 这一组验的不是页面长什么样，而是**它在网线上有多大、第二次打开要不要重传**。
 * 2026-11-27 之前这两件事都没人管：`/mini` 每次回 525 KB 明文、`Cache-Control: no-store`，
 * 手机每打开一次就全量下一遍。数字上的差别只有真的发一次请求才看得出来，
 * 所以这里既测纯函数（renderPageResponse），也起一个真服务器量一遍。
 *
 * ## 为什么不用 fetch
 *
 * `fetch` 会自己带 `accept-encoding` 并**自动解压**，量到的就不是网线上那份字节了。
 * 这里用 `node:http` 原样发、原样收。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createServer as createHttpServer, request as httpRequest } from 'node:http'
import { brotliDecompressSync, gunzipSync } from 'node:zlib'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createMiniServer } from '../lib/server.js'
import { createStore } from '../lib/store.js'
import { renderPage, renderPageResponse } from '../lib/page.js'

const TOKEN = 'testtoken0123456789abcdef012345'

/** 原样发一次请求，不自动解压。 */
function rawGet(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(url, { headers }, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }))
    })
    req.on('error', reject)
    req.end()
  })
}

function decode(res) {
  const enc = String(res.headers['content-encoding'] ?? '')
  if (enc === 'br') return brotliDecompressSync(res.body)
  if (enc === 'gzip') return gunzipSync(res.body)
  return res.body
}

function tempStore() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mini-page-'))
  return createStore({ file: join(dir, 'state.json'), maxHistory: 20 })
}

async function startServer(overrides = {}) {
  const server = await createMiniServer({
    store: tempStore(),
    config: { port: 0, defaultMode: 'minimal' },
    bindAddresses: ['127.0.0.1'],
    token: TOKEN,
    onInstruction: async () => ({ ok: true, sessionId: 's1' }),
    ...overrides,
  })
  return { server, base: `http://127.0.0.1:${server.port}` }
}

// ---------------------------------------------------------------------------
// 纯函数：压缩与协商
// ---------------------------------------------------------------------------

test('接受 br 就发 br，接受 gzip 就发 gzip，什么都不接受发明文——三种解出来是同一份', () => {
  const plain = renderPage({})
  const br = renderPageResponse({}, { acceptEncoding: 'gzip, deflate, br' })
  assert.equal(br.status, 200)
  assert.equal(br.headers['Content-Encoding'], 'br')
  assert.equal(brotliDecompressSync(br.body).toString('utf8'), plain)
  assert.ok(br.body.length < Buffer.byteLength(plain) / 2, 'br 至少要省掉一半，否则这一层就白加了')

  const gz = renderPageResponse({}, { acceptEncoding: 'gzip, deflate' })
  assert.equal(gz.headers['Content-Encoding'], 'gzip')
  assert.equal(gunzipSync(gz.body).toString('utf8'), plain)

  const identity = renderPageResponse({}, { acceptEncoding: '' })
  assert.equal(identity.headers['Content-Encoding'], undefined, '没协商到就别乱标编码')
  assert.equal(identity.body.toString('utf8'), plain)
})

test('q=0 是「别给我这个」，不是「没提过」', () => {
  const out = renderPageResponse({}, { acceptEncoding: 'gzip;q=0, br;q=0' })
  assert.equal(out.headers['Content-Encoding'], undefined,
    '两个都 q=0 时必须退明文——真按 q=0 发过去，有些客户端会直接拒收')
})

test('只写了 * 时按 gzip 发（比 br 保守，谁都认）', () => {
  const out = renderPageResponse({}, { acceptEncoding: '*' })
  assert.equal(out.headers['Content-Encoding'], 'gzip')
})

test('缓存头：private + no-cache + Vary，别让中间缓存把这份页面转给别人', () => {
  const out = renderPageResponse({}, { acceptEncoding: 'gzip' })
  assert.equal(out.headers['Cache-Control'], 'private, no-cache')
  assert.equal(out.headers.Vary, 'Accept-Encoding')
  assert.match(out.headers.ETag, /^"[A-Za-z0-9_-]+-gzip"$/)
  assert.equal(out.headers['Content-Length'], String(out.body.length), 'Content-Length 要等于真实字节数')
})

test('ETag 对得上就 304、没有响应体；换了编码就不算同一份', () => {
  const first = renderPageResponse({}, { acceptEncoding: 'gzip' })
  const again = renderPageResponse({}, { acceptEncoding: 'gzip', ifNoneMatch: first.headers.ETag })
  assert.equal(again.status, 304)
  assert.equal(again.body, null, '304 不许带响应体')

  const br = renderPageResponse({}, { acceptEncoding: 'br', ifNoneMatch: first.headers.ETag })
  assert.equal(br.status, 200, 'gzip 那枚 ETag 不能拿去命中 br 那份字节')

  const star = renderPageResponse({}, { acceptEncoding: 'gzip', ifNoneMatch: '*' })
  assert.equal(star.status, 304)
})

test('不同的注入常量是不同的内容，不能互相命中', () => {
  const gate = renderPageResponse({ needsToken: true }, { acceptEncoding: 'gzip' })
  const normal = renderPageResponse({}, { acceptEncoding: 'gzip' })
  assert.notEqual(gate.headers.ETag, normal.headers.ETag)
  const wrong = renderPageResponse({ needsToken: true }, { acceptEncoding: 'gzip', ifNoneMatch: normal.headers.ETag })
  assert.equal(wrong.status, 200, '拿普通页的 ETag 来问门禁页，必须回 200 而不是 304')
})

// ---------------------------------------------------------------------------
// 真服务器：网线上到底多大、第二次还传不传
// ---------------------------------------------------------------------------

test('真服务：手机上第一次打开拿压缩过的页面，第二次只回 304', async (t) => {
  const { server, base } = await startServer()
  t.after(() => server.close())

  // 真实的打开顺序：先带 ?token= 扫码进来（入场页，不缓存），
  // 之后手机再打开就是光地址 + 设备 cookie——**那一次才是绝大多数**。
  const entry = await rawGet(`${base}/mini?token=${TOKEN}`, { 'accept-encoding': 'br' })
  assert.equal(entry.status, 200)
  const cookie = (entry.headers['set-cookie'] ?? []).map((one) => one.split(';')[0]).join('; ')
  assert.ok(cookie.length > 0, '入场那一下要发设备凭据')

  const url = `${base}/mini`
  const first = await rawGet(url, { 'accept-encoding': 'br', cookie })
  assert.equal(first.status, 200)
  assert.equal(first.headers['content-encoding'], 'br')
  assert.equal(first.headers['cache-control'], 'private, no-cache')
  assert.equal(first.headers.vary, 'Accept-Encoding')
  assert.ok(first.body.length < 200 * 1024, `压缩后 ${Math.round(first.body.length / 1024)} KB，还是太重`)
  // 解出来必须是一整页：有骨架、有样式、有脚本，占位符一个都不剩。
  const html = decode(first).toString('utf8')
  assert.match(html, /<main id="main">/)
  assert.match(html, /<style>[\s\S]*\.bubble \{/)
  assert.match(html, /function mdToHtml/)
  assert.ok(!html.includes('__PAGE_CSS__') && !html.includes('__PAGE_JS__'), '占位符没拼掉')

  const etag = first.headers.etag
  const second = await rawGet(url, { 'accept-encoding': 'br', cookie, 'if-none-match': etag })
  assert.equal(second.status, 304, '同一份内容再问一次，不该重传 150 KB')
  assert.equal(second.body.length, 0)

  // 不认 br 的老浏览器：拿 gzip，内容一样。
  const gz = await rawGet(url, { 'accept-encoding': 'gzip', cookie })
  assert.equal(gz.status, 200)
  assert.equal(gz.headers['content-encoding'], 'gzip')
  assert.deepEqual(decode(gz), decode(first))
})

test('真服务：门禁页也压缩（那一次反而是最常打开的一页）', async (t) => {
  const { server, base } = await startServer()
  t.after(() => server.close())

  const res = await rawGet(`${base}/mini`, { 'accept-encoding': 'gzip' })
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-encoding'], 'gzip')
  const html = decode(res).toString('utf8')
  assert.match(html, /id="gate"/)
  assert.match(html, /var NEEDS_TOKEN = true;/)
})

test('真服务：带 ?token= 的入场页不进缓存（那个地址里就带着令牌）', async (t) => {
  const { server, base } = await startServer()
  t.after(() => server.close())

  const res = await rawGet(`${base}/mini?token=${TOKEN}`, { 'accept-encoding': 'gzip' })
  assert.equal(res.status, 200)
  assert.equal(res.headers['cache-control'], 'no-store')
  assert.equal(res.headers.etag, undefined, '入场页不该给 ETag，它本来就不让存')
  // 但设备凭据照发——「扫一下码之后 0 步」靠的就是这一下。
  assert.ok(String(res.headers['set-cookie'] ?? '').length > 0, '入场那一下要发设备凭据')
})

test('真服务：一个什么都不接受的客户端照样能拿到完整页面', async (t) => {
  const { server, base } = await startServer()
  t.after(() => server.close())

  const res = await rawGet(`${base}/mini?token=${TOKEN}`, { 'accept-encoding': 'identity' })
  assert.equal(res.status, 200)
  assert.equal(res.headers['content-encoding'], undefined)
  assert.equal(Number(res.headers['content-length']), res.body.length)
  assert.match(res.body.toString('utf8'), /<main id="main">/)
})
