/**
 * 移魂的 HTTP 入口（设置页面板用）。
 *
 * 为什么要有这一层：模型的工具只在会话里可用，而设置页是用户自己去点的地方，
 * 两者够不着。所以同一套能力开两条门——工具给模型，路由给界面，实现是同一份。
 *
 * 安全：五条都走 `localOnly`（和其余 `/mini-remote/*` 一样只认同机），
 * 且写入的两条（apply / rollback）要求请求体里带 `confirm: true`，
 * 不靠界面"点两下"当保险。
 */
import { detectProfile, resolveHome } from './env.js'
import { exportSoul, defaultExportDir } from './export.js'
import { inspectSoul } from './inspect.js'
import { planSoul, applySoul, rollbackSoul } from './migrate.js'

export function registerSoulRoutes({ ctx, mountRoute, localOnly, readBody, sendJson, log }) {
  const home = resolveHome()
  const disposers = []

  const post = (path, run) => {
    disposers.push(
      mountRoute({
        kind: 'exact',
        path,
        handler: async (req, res) => {
          if (!localOnly(req, res)) return
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: '这个地址只接受 POST。' })
            return
          }
          let body
          try {
            body = await readBody(req)
          } catch (err) {
            sendJson(res, 400, { ok: false, error: `请求体读不了：${err?.message ?? err}` })
            return
          }
          try {
            const { status, payload } = await run(body || {})
            sendJson(res, status, payload)
          } catch (err) {
            log?.warn?.(`移魂接口 ${path} 出错：${err?.message ?? err}`)
            sendJson(res, 500, { ok: false, error: String(err?.message ?? err) })
          }
        },
      }),
    )
  }

  const currentProfile = (explicit) => {
    let started = []
    try {
      const value = ctx?.get?.('profileContext')?.startedBundles
      if (Array.isArray(value)) started = value
    } catch {
      // 拿不到就交给 detectProfile 报"无法判断"。
    }
    return detectProfile(home, started, explicit ? String(explicit) : '')
  }

  post('/mini-remote/soul/export', async (body) => {
    const detected = currentProfile(body.profile)
    if (!detected.name) {
      return { status: 400, payload: { ok: false, error: `无法确定当前档案：${detected.reason}`, candidates: detected.candidates } }
    }
    const mode = ['none', 'recent', 'all'].includes(String(body.sessions)) ? String(body.sessions) : 'none'
    const outDir = String(body.dir || defaultExportDir(home))
    const result = await exportSoul({
      ctx,
      home,
      profile: detected.name,
      outDir,
      sessions: mode,
      sessionLimit: Number.isFinite(Number(body.sessionLimit)) ? Math.max(1, Number(body.sessionLimit)) : 20,
      attachments: body.attachments === true,
      // 密码只在这次调用里存在：不落盘、不进响应、不进日志。
      password: typeof body.password === 'string' ? body.password : '',
    })
    if (!result.ok) return { status: 400, payload: result }
    return { status: 200, payload: { ...result, profile: detected.name } }
  })

  post('/mini-remote/soul/inspect', async (body) => {
    const packDir = String(body.packDir || '').trim()
    if (!packDir) return { status: 400, payload: { ok: false, error: '要指定包目录。' } }
    const result = await inspectSoul({ packDir, ctx, home })
    return { status: result.ok ? 200 : 400, payload: result }
  })

  post('/mini-remote/soul/plan', async (body) => {
    const packDir = String(body.packDir || '').trim()
    if (!packDir) return { status: 400, payload: { ok: false, error: '要指定包目录。' } }
    const result = await planSoul({ packDir, ctx, home, profile: body.profile ? String(body.profile) : '', pathMap: normalizePathMap(body.pathMap) })
    return { status: result.ok ? 200 : 400, payload: result.ok ? { ...result } : result }
  })

  post('/mini-remote/soul/apply', async (body) => {
    if (body.confirm !== true) return { status: 400, payload: { ok: false, error: '这一步会改配置和文件，需要确认（confirm: true）。' } }
    const packDir = String(body.packDir || '').trim()
    if (!packDir) return { status: 400, payload: { ok: false, error: '要指定包目录。' } }
    const result = await applySoul({
      packDir,
      ctx,
      home,
      profile: body.profile ? String(body.profile) : '',
      planId: body.planId ? String(body.planId) : '',
      confirm: true,
      pathMap: normalizePathMap(body.pathMap),
      password: typeof body.password === 'string' ? body.password : '',
    })
    return { status: result.ok ? 200 : 400, payload: result }
  })

  post('/mini-remote/soul/rollback', async (body) => {
    const snapshotDir = String(body.snapshotDir || '').trim()
    if (!snapshotDir) return { status: 400, payload: { ok: false, error: '要指定快照目录。' } }
    const result = await rollbackSoul({ ctx, snapshotDir })
    return { status: result.ok ? 200 : 400, payload: result }
  })

  return () => {
    for (const dispose of disposers) {
      try {
        dispose?.()
      } catch {
        // 卸载失败不影响其余路由。
      }
    }
  }
}

/** 界面传来的路径映射是数组；脏数据一律丢掉，不往核心逻辑里递。 */
function normalizePathMap(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((m) => m && typeof m.oldPrefix === 'string' && typeof m.newPrefix === 'string' && m.oldPrefix && m.newPrefix)
    .slice(0, 8)
    .map((m) => ({ oldPrefix: m.oldPrefix, newPrefix: m.newPrefix }))
}
