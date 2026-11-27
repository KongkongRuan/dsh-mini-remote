/**
 * 把移动端页面读进来拼成一份 HTML，并给出一份可以直接发的响应（压缩 + ETag）。
 *
 * ## 为什么源文件是三份、对外仍然是一份
 *
 * 页面在 2026-11-27 已经长到 9,977 行：样式 1,960 行、骨架 490 行、主脚本 7,500 行
 * 全挤在一个文件里，改一个气泡要在一万行里找位置。所以拆成 `lib/page/` 下的三份：
 *
 *     shell.html   骨架 + 首屏主题脚本（**必须内联**：主题要在首屏画出来之前定下来）
 *     style.css    样式
 *     app.js       主脚本
 *
 * 但**对外仍然只发一份 HTML**，理由有三条，都是不能动的：
 *   · 门禁页（还没令牌那一次）没有 cookie，拆成子请求就得给静态资源开免鉴权口子；
 *   · 服务端已经把启动常量（模式/令牌/构建指纹/上传上限）注入进来了，拆出去就得多一次往返；
 *   · service worker、镜像页、以及一批"对着页面源码文本匹配"的测试都按一份文档在跑。
 *
 * 拼装在第一次用到时做一次（改完要重启 DSH，理由和 readSw 一样）。**用函数替换而不是
 * 字符串替换**：JS 里有 246 个 `$`，`$&`、`$'` 这类会被 String.replace 当成替换模式
 * 解释，拼出来就不是原文件了。
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { brotliCompressSync, gzipSync, constants as zlibConstants } from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { dirname, extname, isAbsolute, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const PAGE_DIR = join(HERE, 'page')
const SHELL_PATH = join(PAGE_DIR, 'shell.html')
const CSS_PATH = join(PAGE_DIR, 'style.css')
const APP_PATH = join(PAGE_DIR, 'app.js')
const ART_DIR = join(HERE, 'art')
// 插件就在仓库里，`lib/` 的上一级即项目根——正文里写相对路径（如 dsh-image-gen/a.png）时按它找。
const PROJECT_ROOT = join(HERE, '..')

let template = null

/**
 * 三份源文件的绝对路径。
 *
 * 单独交出来是给测试和体量守门用的：它们要按"页面由哪几份组成"来读、来量，
 * 不该各自再写一遍路径——写两遍的那天，加第四份文件就会有一处漏掉。
 */
export function pageFiles() {
  return { shell: SHELL_PATH, css: CSS_PATH, app: APP_PATH }
}

/** 拼一份模板。读不到就抛——宁可这一下打不开，也别发一张半截的页面出去。 */
function pageTemplate() {
  if (template !== null) return template
  const shell = readFileSync(SHELL_PATH, 'utf8')
  const css = readFileSync(CSS_PATH, 'utf8')
  const app = readFileSync(APP_PATH, 'utf8')
  template = shell
    .replace('__PAGE_CSS__', () => css)
    .replace('__PAGE_JS__', () => app)
  return template
}

export function renderPage({ defaultMode = 'minimal', needsToken = false, deviceRevoked = false, build = '', maxUpload = 0 } = {}) {
  return pageTemplate()
    // 三种显示模式都认（单帧/聊天/完整）；不认识的值一律回落单帧——回落要卡在这一处，
    // 各处自己挑认哪几个，迟早出现「存得进去、刷新就变回去」的对不上。
    .replace('__DEFAULT_MODE__', ['chat', 'full'].includes(defaultMode) ? defaultMode : 'minimal')
    .replace('__NEEDS_TOKEN__', needsToken ? 'true' : 'false')
    // 门禁页上那句人话「这台设备的授权已被移除」要不要露出来（见 lib/server.js 那一条
    // 判据）：**被撤销**和**没进过门**是两回事，前者得告诉用户去哪儿重新扫码。
    .replace('__DEVICE_REVOKED__', deviceRevoked ? 'true' : 'false')
    // 立绘地址带上构建指纹（页面自己拼 ?v=__BUILD__），换了图浏览器就不会一直
    // 拿缓存里那张。只留字母数字，别让它有机会往 HTML 里塞东西。
    .replace('__BUILD__', String(build).replace(/[^a-zA-Z0-9]/g, ''))
    // 上传的体积上限由服务端注入，页面里不再写第二份。两处各写一个数迟早会不一致，
    // 而那时候的表现是「页面让你传，服务端拒绝」——最难查的那种不一致。
    .replace('__MAX_UPLOAD__', String(Number(maxUpload) > 0 ? Math.floor(maxUpload) : 0))
}

/* ------------------------------------------------------------------------- *
 * 传输：压缩与 304
 * ------------------------------------------------------------------------- */

/**
 * brotli 质量 9 是量出来的折中：525 KB 的页面压到 153 KB 只要 30 毫秒；
 * 质量 11 能再省 10 KB，但要 500 毫秒——那 500 毫秒会实打实落在用户第一次打开上。
 * gzip 是给不认 br 的浏览器的退路（8 毫秒 / 187 KB）。
 */
const BR_QUALITY = 9
const GZIP_LEVEL = 6

/**
 * 变体缓存。页面内容只随这五个注入常量变，实际组合很少（模式 3 × 门禁 2 × 撤销 2）。
 * 每条存明文 + 两种压缩形态，约 850 KB；上限 8 条是防"某个调用方开始乱传参数"把内存拖走。
 */
const CACHE_LIMIT = 8
const cache = new Map()

function variantKey({ defaultMode = 'minimal', needsToken = false, deviceRevoked = false, build = '', maxUpload = 0 }) {
  // 和 renderPage 一样先归一：不认识的模式一律当单帧、上传上限一律取整。
  // 不归一的话 `'xxx'` 和 `'minimal'` 会各占一条缓存，内容却一模一样。
  const mode = ['chat', 'full'].includes(defaultMode) ? defaultMode : 'minimal'
  const upload = Number(maxUpload) > 0 ? Math.floor(maxUpload) : 0
  return [mode, needsToken ? 1 : 0, deviceRevoked ? 1 : 0, build, upload].join('|')
}

function variantEntry(opts) {
  const key = variantKey(opts)
  let entry = cache.get(key)
  if (entry) return entry
  const raw = Buffer.from(renderPage(opts), 'utf8')
  entry = {
    raw,
    // 明文内容的短哈希：同一份内容不论压不压，认的都是它（压缩形态再拼后缀）。
    tag: createHash('sha256').update(raw).digest('base64url').slice(0, 16),
    br: null,
    gzip: null,
  }
  cache.set(key, entry)
  if (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value)
  return entry
}

/**
 * 从 Accept-Encoding 里挑一种。
 *
 * `q=0` 是"**别**给我这个"，不能当没看见——真按 q=0 发过去，有些客户端会直接拒收。
 * `*` 是通配：只有它、没有明确写 br/gzip 时按 gzip 发（比 br 保守，谁都认）。
 */
function pickEncoding(acceptEncoding) {
  const value = String(acceptEncoding ?? '').toLowerCase()
  if (!value) return 'identity'
  const q = (name) => {
    const m = new RegExp(`(?:^|,)\\s*${name}\\s*(?:;\\s*q=([0-9.]+))?`).exec(value)
    return m ? Number(m[1] ?? 1) : null
  }
  const br = q('br')
  const gzip = q('gzip')
  if (br !== null && br > 0) return 'br'
  if (gzip !== null && gzip > 0) return 'gzip'
  if (br === null && gzip === null) {
    const star = q('\\*')
    if (star !== null && star > 0) return 'gzip'
  }
  return 'identity'
}

function bodyFor(entry, encoding) {
  if (encoding === 'br') {
    entry.br ??= brotliCompressSync(entry.raw, {
      params: { [zlibConstants.BROTLI_PARAM_QUALITY]: BR_QUALITY },
    })
    return entry.br
  }
  if (encoding === 'gzip') {
    entry.gzip ??= gzipSync(entry.raw, { level: GZIP_LEVEL })
    return entry.gzip
  }
  return entry.raw
}

/** `If-None-Match` 可能是逗号分隔的一串、也可能带 `W/` 前缀；`*` 一律算命中。 */
function etagMatches(ifNoneMatch, etag) {
  const raw = String(ifNoneMatch ?? '').trim()
  if (!raw) return false
  if (raw === '*') return true
  return raw.split(',').some((one) => {
    const value = one.trim()
    return value === etag || value === `W/${etag}`
  })
}

/**
 * 造一份可以直接 writeHead/end 的页面响应。
 *
 * 返回 `{ status, headers, body }`：304 时 `body` 是 `null`（没有响应体，这是规范要求的）。
 *
 * ## 为什么缓存头从 no-store 改成 no-cache
 *
 * 这个页面以前每次打开都**全量重传** 525 KB。内容确实会变（注入的启动常量、构建指纹），
 * 但"会变"不等于"不能存"：`no-cache` 是"存下来，但每次先问一句"，问对了就是 304、
 * 一个字节都不用重发。而 `no-store` 连问的机会都没有。
 *
 * `private` 是另一半：页面是给这一台设备看的（门禁/撤销两种形态也在里面），
 * 别让任何中间缓存把它转给别人。
 *
 * `Vary: Accept-Encoding` 不能省：同一份内容有明文/br/gzip 三种字节形态，
 * 少了这个头，中间缓存可能把 br 那份发给不认 br 的客户端。
 */
export function renderPageResponse(opts = {}, { acceptEncoding = '', ifNoneMatch = '' } = {}) {
  const entry = variantEntry(opts)
  const encoding = pickEncoding(acceptEncoding)
  const etag = encoding === 'identity' ? `"${entry.tag}"` : `"${entry.tag}-${encoding}"`
  const headers = {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'private, no-cache',
    Vary: 'Accept-Encoding',
    ETag: etag,
  }
  if (etagMatches(ifNoneMatch, etag)) return { status: 304, headers, body: null }
  const body = bodyFor(entry, encoding)
  if (encoding !== 'identity') headers['Content-Encoding'] = encoding
  headers['Content-Length'] = String(body.length)
  return { status: 200, headers, body }
}

/** 立绘文件名长这样：work-3-typing.webp。 */
const ART_NAME = /^[a-z0-9-]+\.webp$/

/**
 * 读一张立绘，读不到返回 null。
 *
 * 名字用白名单卡死形状——不能只靠调用方过滤。这是唯一一处把请求里的字符串
 * 拼进文件路径的地方，`../` 这类穿越必须在这里就堵死。
 */
export function readArt(name) {
  if (typeof name !== 'string' || !ART_NAME.test(name)) return null
  try {
    return readFileSync(join(ART_DIR, name))
  } catch {
    return null
  }
}

/** 这条通道只发图片：扩展名决定 Content-Type，也决定放不放行。别的类型一概不发。 */
const IMAGE_TYPES = {
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
}

const IMAGE_MAX = 20 * 1024 * 1024

/**
 * 读正文里直接写了一张图的位置时要发的那张图（`![](dsh-image-gen/a.png)` 这种）。
 *
 * 和立绘不一样，这条路上**没有文件名白名单**——正文里写的可以是电脑上任何一张图。
 * 卡的是两点：**只发图片类型**（不然这条通道就成了读文件的口子），以及**体积**。
 * 路径原样按系统解析；相对路径先试项目根、再试 lib/art，都没有就当读不到。
 *
 * 2026-09-28 之前这里只认"把图拷进 lib/art 并写裸名字"一种写法，正文里写全路径就成了
 * 破图标——用户第三次为此来问，这是那时的放宽。
 *
 * `extraRoots`（2026-09-28 追加）是「额外候选根」，由调用方给——服务那边传的是**当前已
 * 注册的工作区目录**。理由：正文里的相对路径相对的是**那段对话的工作目录**，而它可能
 * 是别的项目（实测出图那段对话在 I:\DSH\dsh-jev-ultrafast，正文写 `scratch/x.png`），
 * 插件只按自己的两个根找就会 404，手机上正是那张破图。这里只放宽"在哪找"：
 * 能发什么、发多大、要不要令牌，全都没动。相对写法里带 `..` 一律拒绝——要跨目录，
 * 正文里写绝对路径，那本来就是支持的写法。
 */
export function readImage(raw, extraRoots = []) {
  if (typeof raw !== 'string') return null
  const p = raw.trim()
  if (!p || p.length > 4096 || p.includes('\0')) return null
  const type = IMAGE_TYPES[extname(p).toLowerCase()]
  if (!type) return null
  const abs = isAbsolute(p)
  const roots = Array.isArray(extraRoots) ? extraRoots : []
  if (!abs && p.split(/[\\/]/).includes('..')) return null
  const candidates = abs
    ? [p]
    : [p, join(PROJECT_ROOT, p), join(ART_DIR, p), ...roots.filter((r) => typeof r === 'string' && r).map((r) => join(r, p))]
  for (const file of candidates) {
    try {
      if (statSync(file).size > IMAGE_MAX) continue
      return { buf: readFileSync(file), type }
    } catch {
      // 这个位置没有，试下一个。
    }
  }
  return null
}

const SW_PATH = join(HERE, 'sw.js')

let sw = null

/**
 * 读 service worker 的源码，读不到返回 null。
 *
 * 和页面一样，启动时读一次进内存。**改了它要重启 DSH**——理由和页面完全相同：
 * 服务器手里那份是启动时读的，不重启就还是旧的。
 */
export function readSw() {
  if (sw === null) {
    try {
      sw = readFileSync(SW_PATH, 'utf8')
    } catch {
      sw = ''
    }
  }
  return sw || null
}
