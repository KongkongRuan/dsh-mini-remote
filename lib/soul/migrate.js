/**
 * 计划 / 执行 / 回滚（P1 范围：结构层 + 配置层）。
 *
 * 三条硬规矩，写在这里免得后来人绕过：
 *   1. **先出计划，再执行**。计划带指纹，执行时重算一遍，对不上就整笔拒绝（零写入）。
 *   2. **写之前先备份**。备份里同时记"文件原件"和"改之前的服务状态"，否则回滚只能靠猜。
 *   3. **不装包**。目标机没有的插件一律跳过并如实计数——装包是 P2，混进来会让 P1 变得不可测。
 */
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { readManifest, verifyPack, hashText, toPosix } from './pack.js'
import { materializeLocalTarball } from './local-plugin.js'
import { readProfileManifest } from './env.js'
import { readTextFile } from './export.js'

const PLAN_KIND = 'soul-plan/1'

async function readJson(root, rel) {
  const text = await readTextFile(join(root, rel))
  if (text === null) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** 计划指纹：内容一变指纹就变，执行端据此拒绝"计划看过了但又变了"的情况。 */
export function fingerprintOf(items) {
  const canonical = JSON.stringify(
    items.map((i) => [i.id, i.action, i.target ?? '', i.detail ?? '']).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
  )
  return hashText(`${PLAN_KIND}\n${canonical}`)
}

/**
 * 生成注入计划（只读）。
 *
 * @returns {Promise<object>} `{ ok, planId, items, summary }` 或 `{ ok:false, error }`
 */
export async function planSoul({ packDir, ctx, home, profile }) {
  const read = await readManifest(packDir)
  if (!read.ok) return { ok: false, error: read.error }
  const manifest = read.manifest

  const verify = await verifyPack(packDir)
  if (!verify.ok) {
    return { ok: false, error: `这个包校验不过，不能注入：${verify.problems.slice(0, 3).join('；')}` }
  }

  const sourceProfile = manifest?.source?.profile ?? null
  const targetProfile = profile || sourceProfile
  if (!targetProfile) return { ok: false, error: '包里没写来源档案名，请显式指定目标档案' }

  const items = []

  // ── 结构层 ──
  const pluginManager = ctx?.get?.('pluginManager')
  const liveBundles = (await pluginManager?.listBundles?.()) || []
  const liveByName = new Map((liveBundles || []).map((b) => [b?.name, b]))
  const bundlesFile = await readJson(packDir, 'profile/bundles.json')
  for (const item of Array.isArray(bundlesFile?.bundles) ? bundlesFile.bundles : []) {
    if (!item || typeof item.name !== 'string') continue
    const live = liveByName.get(item.name)
    const id = `bundle:${item.name}`
    if (!live || live.installed === false) {
      // 目标机没装：能拿到安装源就装，拿不到就如实跳过——不要假装装得上去。
      if (typeof item.spec === 'string' && item.spec) {
        items.push({
          id,
          kind: 'install',
          action: 'install',
          target: item.name,
          spec: item.spec,
          localTarball: typeof item.localTarball === 'string' ? item.localTarball : null,
          detail: item.localTarball
            ? `安装本地插件 ${item.name}（用包里带的 tarball）`
            : `安装 ${item.spec}${item.version ? `（源机器上是 ${item.version}）` : ''}`,
        })
      } else {
        items.push({
          id,
          kind: 'bundle',
          action: 'skip',
          target: item.name,
          detail: '目标机没装，而且包里没记下可用的安装源，跳过',
        })
      }
      continue
    }
    const sourceVersion = typeof item.version === 'string' ? item.version : null
    const liveVersion = typeof live.version === 'string' ? live.version : null
    if (sourceVersion && liveVersion && sourceVersion !== liveVersion) {
      items.push({
        id,
        kind: 'install',
        action: 'reinstall',
        target: item.name,
        spec: item.spec || `${item.name}@${sourceVersion}`,
        oldVersion: liveVersion,
        detail: `目标机是 ${liveVersion}，源机器是 ${sourceVersion}；先卸再装（官方规定不能直接覆盖）`,
      })
      continue
    }
    if (live.enabled === false) {
      items.push({
        id,
        kind: 'bundle',
        action: 'enable',
        target: item.name,
        detail: `启用 ${item.name}${item.version ? ` ${item.version}` : ''}`,
      })
    } else {
      items.push({ id, kind: 'bundle', action: 'noop', target: item.name, detail: '已启用，无需改动' })
    }
  }

  // ── 配置层：settings ──
  const settings = ctx?.get?.('settings')
  const settingsFile = await readJson(packDir, 'settings/namespaces.json')
  const sourceNamespaces = settingsFile?.namespaces && typeof settingsFile.namespaces === 'object'
    ? settingsFile.namespaces
    : {}
  if (settingsFile?.unavailable) {
    items.push({
      id: 'settings:unavailable',
      kind: 'settings',
      action: 'skip',
      target: '',
      detail: `导出时就没读到配置：${settingsFile.reason || '原因未记录'}`,
    })
  } else if (!settings) {
    items.push({
      id: 'settings:no-service',
      kind: 'settings',
      action: 'skip',
      target: '',
      detail: '这台 DSH 没有 settings 服务，配置无法写入',
    })
  } else {
    let live = null
    if (typeof settings.describeAll === 'function') {
      try {
        const all = await settings.describeAll.call(settings, { redactSecrets: true })
        live = new Map((all || []).map((e) => [e?.ns, e?.info]))
      } catch {
        live = null
      }
    }
    for (const [ns, payload] of Object.entries(sourceNamespaces)) {
      const id = `settings:${ns}`
      if (!live) {
        items.push({
          id,
          kind: 'settings',
          action: 'skip',
          target: ns,
          detail: '读不到目标机的配置清单，不敢盲写',
        })
        continue
      }
      const current = live.get(ns)
      if (!current) {
        // 官方口径：settings 的 namespace 就是 profile 条目 id，条目不在就写不进去。
        items.push({
          id,
          kind: 'settings',
          action: 'skip',
          target: ns,
          detail: '目标机没有这个配置条目（对应插件没装或没启用），跳过',
        })
        continue
      }
      const same = JSON.stringify(current.value ?? null) === JSON.stringify(payload?.value ?? null)
      items.push({
        id,
        kind: 'settings',
        action: same ? 'noop' : 'replace',
        target: ns,
        detail: same ? '值相同，无需改动' : '用包里的值替换目标机的生效配置',
      })
    }
  }

  // ── 配置层：两层 patch（整份替换，官方口径非深合并）──
  const patchPairs = [
    ['home', 'profile/patches/home.cordis.patch.yml', join(home, 'cordis.patch.yml')],
    ['profile', 'profile/patches/profile.cordis.patch.yml', join(home, 'profiles', targetProfile, 'cordis.patch.yml')],
  ]
  for (const [layer, rel, dest] of patchPairs) {
    const source = await readTextFile(join(packDir, rel))
    if (source === null) continue
    const current = await readTextFile(dest)
    const same = current !== null && current === source
    items.push({
      id: `patch:${layer}`,
      kind: 'patch',
      action: same ? 'noop' : current === null ? 'create' : 'replace',
      target: toPosix(dest),
      detail: same ? '内容相同，无需改动' : `${layer} 层 patch 整份${current === null ? '新建' : '替换'}（替换前备份）`,
      source: rel,
    })
  }

  // ── 自定义文件 ──
  const { listFilesDeep } = await import('./pack.js')
  const customRoot = join(packDir, 'custom')
  const skillRoot = join(packDir, 'custom/skills')
  const presetRoot = join(packDir, 'custom/agent-presets')
  const customFiles = await listFilesDeep(customRoot)
  for (const abs of customFiles) {
    const rel = toPosix(abs.slice(customRoot.length + 1))
    let destRel = null
    if (rel === 'AGENTS.md') destRel = 'AGENTS.md'
    else if (rel.startsWith('skills/')) destRel = rel
    else if (rel.startsWith('agent-presets/')) destRel = rel.replace('agent-presets/', '.agent-presets/')
    if (!destRel) continue
    const dest = join(home, destRel)
    const current = await readTextFile(dest)
    const source = await readTextFile(abs)
    const same = current !== null && current === source
    items.push({
      id: `file:${destRel}`,
      kind: 'file',
      action: same ? 'noop' : current === null ? 'create' : 'replace',
      target: toPosix(dest),
      detail: same ? '内容相同' : current === null ? '新增文件' : '覆盖同名文件（覆盖前备份）',
      // 源路径要相对**包根**，执行端才找得到；rel 是相对 custom/ 的。
      source: `custom/${rel}`,
    })
  }

  const plan = {
    kind: PLAN_KIND,
    packDir: toPosix(packDir),
    targetProfile,
    sourceDshVersion: manifest?.source?.dshVersion ?? 'unknown',
    items,
    createdAt: new Date().toISOString(),
  }
  plan.planId = fingerprintOf(items)

  const summary = countActions(items)
  return { ok: true, plan, planId: plan.planId, summary }
}

export function countActions(items) {
  const summary = { install: 0, reinstall: 0, enable: 0, replace: 0, create: 0, noop: 0, skip: 0 }
  for (const item of items || []) {
    if (item.action in summary) summary[item.action] += 1
  }
  return summary
}

/**
 * 执行计划。**必须带 planId**；执行前会重算一次计划，指纹不符直接拒绝（零写入）。
 */
export async function applySoul({ packDir, ctx, home, profile, planId, confirm }) {
  if (confirm !== true) return { ok: false, error: '这一步会改配置和文件，需要明确确认（confirm: true）' }

  const fresh = await planSoul({ packDir, ctx, home, profile })
  if (!fresh.ok) return fresh
  if (planId && planId !== fresh.planId) {
    return {
      ok: false,
      error: `计划已经变了（可能包被替换或目标机状态变了）。重新看一眼计划再执行。当前 planId=${fresh.planId}`,
    }
  }
  const effective = fresh.plan
  const work = effective.items.filter((i) => i.action !== 'noop' && i.action !== 'skip')
  if (work.length === 0) {
    return { ok: true, changed: false, planId: fresh.planId, summary: fresh.summary, journal: [], notes: ['没有需要改的东西'] }
  }

  const snapshotDir = await createSnapshotDirectory(home)
  const journal = []
  const notes = []

  // 顺序固定：先结构（启用插件），再配置（settings），最后文件（patch / 自定义）。
  // 反过来做的话，配置可能写进一个"还没启用"的条目而失败。
  const order = { install: 0, bundle: 1, settings: 2, patch: 3, file: 4 }
  const queue = [...work].sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9))

  for (const item of queue) {
    try {
      if (item.kind === 'install') {
        const pluginManager = ctx?.get?.('pluginManager')
        if (!pluginManager?.installBundle) {
          notes.push(`跳过安装 ${item.target}：这台 DSH 没有 pluginManager`)
          journal.push({ ...item, result: 'skipped' })
          continue
        }
        // reinstall 必须先删：官方规定 installBundle 命中已安装包会直接失败，
        // 删除会停掉该 bundle 的插件并清掉包映射，再装才会真的换版本。
        if (item.action === 'reinstall') {
          if (!pluginManager.removeBundle) {
            notes.push(`跳过 ${item.target}：没有 removeBundle，无法换版本`)
            journal.push({ ...item, result: 'skipped' })
            continue
          }
          await pluginManager.removeBundle(item.target)
          // 回滚时把旧版本装回去（尽力而为，装不回也如实记）。
          await record(snapshotDir, { kind: 'bundle-version', target: item.target, oldSpec: `${item.target}@${item.oldVersion ?? ''}` })
        } else {
          // 新装的包：回滚时卸掉。
          await record(snapshotDir, { kind: 'bundle-install', target: item.target })
        }
        let spec = item.spec
        if (item.localTarball) {
          // 包里的 tarball 要先落到本机，`file:` 才能被包管理器解析；临时目录不行，
          // 那会写进一条指向易失路径的持久依赖。
          const abs = await materializeLocalTarball({
            packDir,
            rel: item.localTarball,
            home,
            name: item.target,
          })
          spec = `file:${abs}`
        }
        const res = await pluginManager.installBundle(spec)
        if (res?.application === 'failed') {
          const code = res?.error?.code ?? 'unknown'
          // already-installed 不算失败：目标机本来就有，继续往下启用即可。
          if (code === 'already-installed') {
            journal.push({ ...item, result: 'skipped', error: '目标机已经有了，跳过安装' })
            notes.push(`${item.target} 目标机已安装，跳过安装`)
          } else {
            journal.push({ ...item, result: 'failed', error: `${code}: ${res?.error?.message ?? ''}` })
            notes.push(`${item.target} 安装失败：${code}`)
          }
          continue
        }
        journal.push({ ...item, result: 'applied' })
        if (res?.application === 'restart-required') notes.push(`${item.target} 装好了，需要重启 DSH 才生效`)
        continue
      }

      if (item.kind === 'bundle') {
        const pluginManager = ctx?.get?.('pluginManager')
        if (!pluginManager?.setBundleEnabled) {
          notes.push(`跳过 ${item.target}：这台 DSH 没有 pluginManager，改不了 bundle 启用状态`)
          journal.push({ ...item, result: 'skipped' })
          continue
        }
        const before = (await pluginManager.listBundles?.())?.find((b) => b?.name === item.target)
        await record(snapshotDir, { kind: 'bundle', target: item.target, oldEnabled: before?.enabled === true })
        const res = await pluginManager.setBundleEnabled(item.target, true)
        journal.push({ ...item, result: res?.application ?? 'applied' })
        if (res?.application === 'restart-required') notes.push(`${item.target} 需要重启 DSH 才生效`)
        continue
      }

      if (item.kind === 'settings') {
        const settings = ctx?.get?.('settings')
        const packSettings = await readJson(packDir, 'settings/namespaces.json')
        const payload = packSettings?.namespaces?.[item.target]
        if (!settings?.replace || !payload) {
          notes.push(`跳过配置 ${item.target}：缺少可写入的值或服务`)
          journal.push({ ...item, result: 'skipped' })
          continue
        }
        // 现读一次 revision：拿旧计划里的 revision 去写必然被拒。
        const all = typeof settings.describeAll === 'function'
          ? await settings.describeAll.call(settings, { redactSecrets: true })
          : []
        const current = (all || []).find((e) => e?.ns === item.target)?.info
        if (!current) {
          notes.push(`跳过配置 ${item.target}：目标机现在没有这个条目`)
          journal.push({ ...item, result: 'skipped' })
          continue
        }
        await record(snapshotDir, {
          kind: 'settings',
          target: item.target,
          oldValue: current.value ?? null,
        })
        await settings.replace(item.target, payload.value, current.revision)
        journal.push({ ...item, result: 'applied' })
        continue
      }

      // patch 与自定义文件都是"整份写入"，先备份再写。
      const source = await readTextFile(join(packDir, item.source))
      if (source === null) {
        notes.push(`跳过 ${item.target}：包里的源文件不见了`)
        journal.push({ ...item, result: 'skipped' })
        continue
      }
      await mkdir(dirname(item.target), { recursive: true })
      const existed = await readTextFile(item.target)
      if (existed !== null) {
        await record(snapshotDir, { kind: 'file', target: item.target, backup: await backupFile(snapshotDir, item.target) })
      } else {
        await record(snapshotDir, { kind: 'file', target: item.target, backup: null })
      }
      await writeFile(item.target, source, 'utf8')
      journal.push({ ...item, result: 'applied' })
    } catch (err) {
      journal.push({ ...item, result: 'failed', error: String(err?.message ?? err) })
      notes.push(`${item.target} 失败：${err?.message ?? err}`)
    }
  }

  const failed = journal.filter((j) => j.result === 'failed')
  // 注意：**不要覆盖 `journal.json`**。那份是"回滚凭据"（记原件与旧值），
  // 这里写的是"这次做了什么"，放 `result.json`，两者混在一起会让回滚读不到备份。
  await writeFile(join(snapshotDir, 'result.json'), `${JSON.stringify({ planId: fresh.planId, journal, notes }, null, 2)}\n`, 'utf8')

  return {
    ok: failed.length === 0,
    changed: journal.some((j) => j.result === 'applied'),
    planId: fresh.planId,
    snapshotDir: toPosix(snapshotDir),
    summary: fresh.summary,
    journal,
    notes,
    failed: failed.length,
    // 回滚入口把快照目录交出去，用户不必自己去找。
    hint: failed.length === 0
      ? '有需要重启的项就重启 DSH；不满意可以用 soul_rollback 回到这次之前。'
      : '有项失败，可用 soul_rollback 整笔退回。',
  }
}

async function createSnapshotDirectory(home) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '')
  const dir = join(home, 'dsh-mini-remote', 'souls', '.snapshots', stamp)
  await mkdir(dir, { recursive: true })
  return dir
}

async function record(snapshotDir, entry) {
  const file = join(snapshotDir, 'journal.json')
  let data = { entries: [] }
  try {
    data = JSON.parse(await readFile(file, 'utf8'))
    if (!Array.isArray(data.entries)) data.entries = []
  } catch {
    // 第一次写。
  }
  data.entries.push(entry)
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
}

async function backupFile(snapshotDir, target) {
  const name = hashText(target).slice(0, 16)
  const dest = join(snapshotDir, 'files', name)
  await mkdir(dirname(dest), { recursive: true })
  await cp(target, dest)
  return toPosix(dest)
}

/** 回滚：把快照里记的东西退回去。文件按备份还原，服务状态按记录改回。 */
export async function rollbackSoul({ ctx, snapshotDir }) {
  let data
  try {
    data = JSON.parse(await readFile(join(snapshotDir, 'journal.json'), 'utf8'))
  } catch (err) {
    return { ok: false, error: `读不到快照记录（${err?.message ?? err}）` }
  }
  const entries = Array.isArray(data.entries) ? data.entries : []
  const done = []
  const failed = []
  // 逆序退：后做的先撤，谁也别踩谁。
  for (const entry of [...entries].reverse()) {
    try {
      if (entry.kind === 'file') {
        if (entry.backup) await cp(entry.backup, entry.target)
        else await rm(entry.target, { force: true })
        done.push(`文件 ${entry.target}`)
      } else if (entry.kind === 'settings') {
        const settings = ctx?.get?.('settings')
        if (!settings?.replace) throw new Error('没有 settings 服务')
        const all = typeof settings.describeAll === 'function'
          ? await settings.describeAll.call(settings, { redactSecrets: true })
          : []
        const current = (all || []).find((e) => e?.ns === entry.target)?.info
        if (!current) throw new Error('这个配置条目现在不存在了')
        await settings.replace(entry.target, entry.oldValue, current.revision)
        done.push(`配置 ${entry.target}`)
      } else if (entry.kind === 'bundle-install') {
        const pluginManager = ctx?.get?.('pluginManager')
        if (!pluginManager?.removeBundle) throw new Error('没有 removeBundle')
        await pluginManager.removeBundle(entry.target)
        done.push(`卸载本次新装的 ${entry.target}`)
      } else if (entry.kind === 'bundle-version') {
        const pluginManager = ctx?.get?.('pluginManager')
        if (!pluginManager?.installBundle || !entry.oldSpec || entry.oldSpec.endsWith('@')) {
          throw new Error('没有记下旧版本，装不回去')
        }
        const res = await pluginManager.installBundle(entry.oldSpec)
        if (res?.application === 'failed') throw new Error(res?.error?.code ?? 'install failed')
        done.push(`把 ${entry.target} 装回 ${entry.oldSpec}`)
      } else if (entry.kind === 'bundle') {
        const pluginManager = ctx?.get?.('pluginManager')
        if (!pluginManager?.setBundleEnabled) throw new Error('没有 pluginManager')
        await pluginManager.setBundleEnabled(entry.target, entry.oldEnabled === true)
        done.push(`插件 ${entry.target}（启用状态改回 ${entry.oldEnabled === true}）`)
      }
    } catch (err) {
      failed.push(`${entry.target ?? entry.kind}：${err?.message ?? err}`)
    }
  }
  return { ok: failed.length === 0, restored: done, failed }
}
