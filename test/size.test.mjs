/**
 * 体量守门（2026-10-17 立；2026-11-27 跟着拆页改写）。
 *
 * 这几条守的不是"代码质量"，是**别无声地长大**。
 *
 * ## 页面现在由三份源文件组成，但对外还是一页
 *
 * 2026-11-27 之前是单文件 `lib/page.html`（9,977 行 / 525 KB）：改一个气泡要在一万行里
 * 找位置。现在拆成 `lib/page/` 下的 shell.html（骨架）、style.css、app.js，
 * 服务器启动时拼回一份 HTML 发出去——**拼回来和原文件逐字节一致**，是迁移脚本
 * `tools/split-page.mjs` 当场断言过的，不是"差不多"。
 *
 * 所以这里量的仍然是**拼起来那一页**；三份各自的上限只防"某一份偷偷长成新的巨无霸"。
 *
 * ## 阈值怎么定的
 *
 * 拼起来：当前 10,067 行 / 530 KB，守 10,150 行 / 535 KB。拦的是"又长了一千行"这种，
 * 不拦正常改动（2026-11-27 加「鲸鱼娘」开关那一行时撞到过旧线 10,100/530，顺手把两条
 * 各往上放了一档，留的还是原来那点余量）。真需要长过去的时候改这个数——那一下就是
 * 该停下来想一想的时刻。
 * （注意：这里的行数**含空行**。`Measure-Object -Line` 那一类工具不数空行，
 * 用它会把这文件读成 6,246 行，差了两千，口径不一样。）
 *
 * 压缩后：brotli 153 KB、gzip 187 KB，守 170 / 205 KB。这一条是 2026-11-27 新加的：
 * 传输层加了压缩之后，"页面重不重"终于有一个和用户直接相关的数字可守了。
 *
 * ## 为什么包体要调 `npm pack` 而不是自己遍历目录
 *
 * 2026-10-17 踩过一次：自己按 `files` 白名单遍历工作区，算出 10.78 MB，于是断定
 * "包体太大"——**错了**。`lib/art/.npmignore` 里一行 `out-*` 把过程产物挡在包外，
 * 真实包体只有 2.1 MB。**自己模拟打包规则 = 第二份真相**，迟早和 npm 说的不一样。
 * 所以这里直接问 npm 要数字。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { brotliCompressSync, gzipSync, constants as zlibConstants } from 'node:zlib'

import { pageFiles } from '../lib/page.js'
import { pageSource } from './page-source.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const KB = (n) => Math.round(n / 1024)

/** 每份源文件的体量：`[pageFiles() 的键, 文件名, 行数上限, KB 上限]`。 */
const PARTS = [
  ['shell', 'shell.html', 600, 35],
  ['css', 'style.css', 2150, 130],
  ['app', 'app.js', 8250, 410],
]

test('手机页体量：拼起来不超过 10150 行 / 535 KB（超了就该重新想结构，不是继续往下堆）', () => {
  const html = pageSource()
  const lines = html.split('\n').length
  const kb = KB(Buffer.byteLength(html))
  assert.ok(lines <= 10150, `手机页拼起来已经 ${lines} 行，越过守门线 10150 了`)
  assert.ok(kb <= 535, `手机页拼起来已经 ${kb} KB，越过守门线 535 KB 了`)
})

test('手机页的每一份也各有上限（别再让某一份长成新的巨无霸）', () => {
  const files = pageFiles()
  for (const [key, name, maxLines, maxKb] of PARTS) {
    const text = readFileSync(files[key], 'utf8')
    const lines = text.split('\n').length
    const kb = KB(Buffer.byteLength(text))
    assert.ok(lines <= maxLines, `lib/page/${name} 已经 ${lines} 行，越过守门线 ${maxLines} 了`)
    assert.ok(kb <= maxKb, `lib/page/${name} 已经 ${kb} KB，越过守门线 ${maxKb} KB 了`)
  }
})

test('传输体量：brotli ≤ 170 KB、gzip ≤ 205 KB（这是手机真正要下的那份）', () => {
  const raw = Buffer.from(pageSource(), 'utf8')
  const br = brotliCompressSync(raw, { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 9 } }).length
  const gz = gzipSync(raw, { level: 6 }).length
  assert.ok(KB(br) <= 170, `brotli 后已经 ${KB(br)} KB，越过守门线 170 KB 了`)
  assert.ok(KB(gz) <= 205, `gzip 后已经 ${KB(gz)} KB，越过守门线 205 KB 了`)
})

test('发布包体量：问 npm 要真实数字，不超过 3 MB（现在约 2.6 MB）', () => {
  // `--dry-run` 不写文件；`--json` 让我们拿到 `unpackedSize`，那是 npm 自己算的。
  let parsed
  try {
    const out = execSync('npm pack --dry-run --json', {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120000,
      // npm 在 Windows 上是 npm.cmd，必须走 shell 才找得到。
      shell: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    parsed = JSON.parse(out)
  } catch (err) {
    // 拿不到数字时说"没验到"，而不是报一个假的体积。
    assert.fail(`npm pack --dry-run 没跑通，包体这一条这次没验到：${err?.message ?? err}`)
  }
  const entry = Array.isArray(parsed) ? parsed[0] : parsed
  assert.ok(entry && Number.isFinite(entry.unpackedSize), 'npm 返回里没有 unpackedSize')

  const mb = Math.round((entry.unpackedSize / (1024 * 1024)) * 100) / 100
  assert.ok(entry.unpackedSize <= 3 * 1024 * 1024,
    `发布包已经 ${mb} MB，越过守门线 3 MB。先看是不是有过程产物混进了 lib/：`
    + 'lib/art/.npmignore 里那条 `out-*` 是唯一一道闸。')
  // 顺手钉一下"包里到底有没有那批过程产物"。体积是会飘的，这条更直接。
  const artFiles = (entry.files ?? []).filter((one) => String(one.path).startsWith('lib/art/'))
  const outFiles = artFiles.filter((one) => /^lib\/art\/out-/.test(String(one.path)))
  assert.equal(outFiles.length, 0,
    `lib/art/ 里混进了过程产物：${outFiles.map((one) => one.path).join('、')}`)
})
