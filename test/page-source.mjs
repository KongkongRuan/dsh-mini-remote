/**
 * 手机页的源码文本——三份源文件拼回一份，和服务器发出去的那份同构。
 *
 * 页面在 2026-11-27 从单文件拆成了 `lib/page/` 下的三份（骨架/样式/主脚本），
 * 但这一批测试要验的是**拼出来那一页**：按函数名、选择器切片的锚点本来就跨了样式和
 * 脚本，只有拼回整份才有意义。所以"页面由哪几份组成、怎么拼"只写在这里一处——
 * 将来再加第四份，改这个文件就够，不用去改几十处切片。
 *
 * 和 `lib/page.js` 里的拼法逐字一致（连"用函数替换"这一点也一样：JS 里有 `$`，
 * 字符串替换会把 `$&` 当替换模式解释）。
 */
import { readFileSync } from 'node:fs'
import { pageFiles } from '../lib/page.js'

export function pageSource() {
  const { shell, css, app } = pageFiles()
  return readFileSync(shell, 'utf8')
    .replace('__PAGE_CSS__', () => readFileSync(css, 'utf8'))
    .replace('__PAGE_JS__', () => readFileSync(app, 'utf8'))
}
