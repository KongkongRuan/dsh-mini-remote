/**
 * 一次性迁移工具：把单文件 lib/page.html 拆成三份源文件。
 *
 * 只在这次迁移里跑一次。留在这里的唯一理由是**可复核**：
 * 拆分是纯机械操作，拼回去必须和原文件逐字节一致——否则就不是"拆"，是"改"。
 *
 *     node tools/split-page.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PAGE = join(ROOT, 'lib', 'page.html')
const OUT = join(ROOT, 'lib', 'page')

const src = readFileSync(PAGE, 'utf8')

// 只对**拆分前**的单文件有效。对着拆分后的骨架再跑一次，会把两个占位符当成
// 样式和脚本写进 lib/page/*.css/js——那是把源文件覆盖成一行占位符，必须在这里拦住。
if (src.includes('__PAGE_CSS__') || src.includes('__PAGE_JS__')) {
  throw new Error('lib/page.html 已经是拆分后的骨架了；这个脚本只对拆分前的单文件有效，不要重跑。')
}

const STYLE_OPEN = '<style>\n'
const STYLE_CLOSE = '</style>'
const SCRIPT_OPEN = '<script>\n'

const cssStart = src.indexOf(STYLE_OPEN)
if (cssStart < 0) throw new Error('找不到 <style> 起点')
const cssEnd = src.indexOf(STYLE_CLOSE, cssStart)
if (cssEnd < 0) throw new Error('找不到 </style> 终点')

const jsStart = src.lastIndexOf(SCRIPT_OPEN)
if (jsStart < 0) throw new Error('找不到主脚本的 <script> 起点')
const jsEnd = src.lastIndexOf('</script>')
if (jsEnd < jsStart) throw new Error('找不到主脚本的 </script> 终点')

const css = src.slice(cssStart + STYLE_OPEN.length, cssEnd)
const app = src.slice(jsStart + SCRIPT_OPEN.length, jsEnd)

// 两段之间（主题脚本 + 正文骨架）原样留在 shell 里：它们本来就该是内联的
// （主题要在首屏前定下来，骨架是页面结构），拆出去只会让首屏闪一下。
const shell = src.slice(0, cssStart + STYLE_OPEN.length)
  + '__PAGE_CSS__'
  + src.slice(cssEnd, jsStart + SCRIPT_OPEN.length)
  + '__PAGE_JS__'
  + src.slice(jsEnd)

const assembled = shell.replace('__PAGE_CSS__', () => css).replace('__PAGE_JS__', () => app)
if (assembled !== src) {
  let i = 0
  while (i < assembled.length && i < src.length && assembled[i] === src[i]) i += 1
  throw new Error(`拼回结果和原文件不一致，第一个差异在偏移 ${i}：\n原：${JSON.stringify(src.slice(Math.max(0, i - 40), i + 40))}\n新：${JSON.stringify(assembled.slice(Math.max(0, i - 40), i + 40))}`)
}

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'style.css'), css)
writeFileSync(join(OUT, 'app.js'), app)
writeFileSync(join(OUT, 'shell.html'), shell)
writeFileSync(PAGE, shell)

console.log('ok', { shell: shell.length, css: css.length, app: app.length })
