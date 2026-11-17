/**
 * 导出"灵魂"的**结构层 + 配置层**（P1 范围）。
 *
 * P1 只搬两样东西：
 *   · 结构层 —— 这个档案装了哪些 bundle、什么顺序、什么版本；
 *   · 配置层 —— 各插件的生效配置（经 settings 服务读，读的是活值）、两层 patch、AGENTS.md、技能、预设。
 *
 * **不碰**会话与附件（P3）、不碰凭据值（P4）、不装任何包（P2）。范围小是故意的：
 * 这两层搬对了，目标机才算"像本尊"；搬错了，最多是配置不对，不会把机器搞坏。
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { copyInto, finalizePack, listFilesDeep, toPosix, writeJsonFile } from './pack.js'
import { listProfileNames, readProfileManifest, resolveDshVersion } from './env.js'
import { isLocalSpec, packLocalPlugin } from './local-plugin.js'
import { exportSessions, exportAttachments } from './sessions.js'
import { collectSecrets, writeSecrets } from './secrets.js'

/** 读 settings 的全部 namespace（redacted）。宿主没有 `describeAll` 就如实说读不到。 */
async function readSettings(ctx) {
  const settings = ctx?.get?.('settings')
  if (!settings) return { ok: false, reason: '这台 DSH 没有 settings 服务' }
  const describeAll = settings.describeAll
  if (typeof describeAll !== 'function') {
    // 不逐个 describe：DSH 的 describe() 每次都会对全部注册项重跑 schema 校验，
    // 按名单逐个问是 O(N²)（实测 24 个 namespace 约 1.7 秒）。宁可如实说"读不到"。
    return { ok: false, reason: '这台 DSH 的 settings 服务不支持一次性列举（缺少 describeAll）' }
  }
  try {
    const all = await describeAll.call(settings, { redactSecrets: true })
    const namespaces = {}
    for (const entry of all || []) {
      const ns = entry?.ns
      const info = entry?.info
      if (typeof ns !== 'string' || !ns) continue
      namespaces[ns] = {
        value: info?.value ?? null,
        revision: typeof info?.revision === 'number' ? info.revision : null,
      }
    }
    return { ok: true, namespaces }
  } catch (err) {
    return { ok: false, reason: `读配置失败：${err?.message ?? err}` }
  }
}

/** 把 bundle 列表与运行中的实际状态对齐：版本、是否装、是否启用。 */
function mergeBundles(ordered, runtimeList) {
  const byName = new Map()
  for (const item of runtimeList || []) {
    if (item && typeof item.name === 'string') byName.set(item.name, item)
  }
  return ordered.map((name) => {
    const live = byName.get(name)
    const version = typeof live?.version === 'string' ? live.version : null
    const spec = typeof live?.installTarget?.spec === 'string' ? live.installTarget.spec : null
    return {
      name,
      // 档案里写着，但目标对象没报出来：可能没装。导入时要按"装没装"分别处理。
      installed: live ? live.installed !== false : false,
      enabled: live ? live.enabled !== false : true,
      version,
      // 装包要的是"怎么装"，不是"装在哪"：优先用宿主给的安装源；
      // 它没给（例如只在 bundles 里声明过的包）就用 name@version 兜底。
      spec: spec || (version ? `${name}@${version}` : name),
      specSource: spec ? 'installTarget' : 'name-version',
      official: live?.official === true,
    }
  })
}

/**
 * 导出。
 *
 * @param {object} p
 * @param {object} p.ctx 插件 ctx（用来读服务，只读）
 * @param {string} p.home `$DSH_HOME`
 * @param {string} p.profile 档案名（已由调用方确认，不接受"猜"）
 * @param {string} p.outDir 输出目录（不存在会自动建）
 * @returns {Promise<object>} 摘要：写了什么、跳过了什么、多大
 */
export async function exportSoul({ ctx, home, profile, outDir, runPack, sessions = 'none', sessionLimit = 20, attachments = false, password = '' }) {
  const notes = []
  const manifest = readProfileManifest(home, profile)
  if (!manifest.found) {
    return { ok: false, error: `档案「${profile}」下没有 package.json，不像是一个档案目录` }
  }

  const dshVersion = await resolveDshVersion(ctx)
  const pluginManager = ctx?.get?.('pluginManager')
  let runtimeBundles = []
  try {
    runtimeBundles = (await pluginManager?.listBundles?.()) || []
  } catch (err) {
    notes.push(`读不到运行中的 bundle 状态（${err?.message ?? err}），版本与安装状态会缺`)
  }

  // ── 结构层 ──
  const bundles = mergeBundles(manifest.bundles, runtimeBundles)

  // 本地源插件（link:/file:/裸路径）在目标机上必然找不到，必须把源码打成 tarball 带走。
  // 打不成的**不隐藏**：记进 notes，导入时那条会变成 skip，用户看得见缺了什么。
  let localPacked = 0
  for (const bundle of bundles) {
    if (!isLocalSpec(bundle.spec)) continue
    const packed = await packLocalPlugin({ name: bundle.name, spec: bundle.spec, home, outRoot: outDir, runPack })
    bundle.specKind = 'local'
    if (packed.ok) {
      bundle.localTarball = packed.rel
      bundle.localBytes = packed.bytes
      bundle.sourcePath = packed.source
      localPacked += 1
    } else {
      notes.push(`本地插件 ${bundle.name} 没打包：${packed.reason}`)
    }
  }
  await writeJsonFile(outDir, 'profile/bundles.json', {
    profile,
    order: bundles.map((b) => b.name),
    bundles,
  })
  await writeJsonFile(outDir, 'profile/dependencies.json', manifest.dependencies || {})

  // 两层 patch 原样带走：导入时是**整份替换**（官方口径：用户补丁非深合并），
  // 所以这里必须是原文，不能解析后再拼。
  const patchLayers = []
  const homePatch = join(home, 'cordis.patch.yml')
  if (await copyInto(outDir, 'profile/patches/home.cordis.patch.yml', homePatch)) {
    patchLayers.push('home')
  } else {
    notes.push('这台机器没有 home 层 patch（cordis.patch.yml），跳过')
  }
  const profilePatch = join(home, 'profiles', profile, 'cordis.patch.yml')
  if (await copyInto(outDir, 'profile/patches/profile.cordis.patch.yml', profilePatch)) {
    patchLayers.push('profile')
  } else {
    notes.push('这个档案没有自己的 cordis.patch.yml，跳过')
  }

  // ── 配置层 ──
  const settings = await readSettings(ctx)
  if (settings.ok) {
    await writeJsonFile(outDir, 'settings/namespaces.json', {
      readAt: new Date().toISOString(),
      note: 'value 是 redacted 的生效值；revision 只用于对照，导入时会重新读。',
      namespaces: settings.namespaces,
    })
  } else {
    notes.push(`没有导出配置：${settings.reason}`)
    await writeJsonFile(outDir, 'settings/namespaces.json', {
      unavailable: true,
      reason: settings.reason,
      namespaces: {},
    })
  }

  // ── 自定义文件（提示词之外的那些"人写的"东西）──
  const custom = []
  const addFile = async (rel, abs) => {
    if (await copyInto(outDir, rel, abs)) custom.push(rel)
  }
  await addFile('custom/AGENTS.md', join(home, 'AGENTS.md'))

  const skillsDir = join(home, 'skills')
  if (existsSync(skillsDir)) {
    for (const abs of await listFilesDeep(skillsDir)) {
      const rel = toPosix(abs.slice(skillsDir.length + 1))
      await copyInto(outDir, `custom/skills/${rel}`, abs)
      custom.push(`custom/skills/${rel}`)
    }
    if (custom.filter((r) => r.startsWith('custom/skills/')).length === 0) {
      notes.push('skills/ 是空的，没有技能要带走')
    }
  } else {
    notes.push('这台机器没有 skills 目录')
  }

  const presetsDir = join(home, '.agent-presets')
  if (existsSync(presetsDir)) {
    for (const abs of await listFilesDeep(presetsDir)) {
      const rel = toPosix(abs.slice(presetsDir.length + 1))
      await copyInto(outDir, `custom/agent-presets/${rel}`, abs)
      custom.push(`custom/agent-presets/${rel}`)
    }
  } else {
    notes.push('这台机器没有 .agent-presets 目录')
  }

  // ── 记忆层（可选，默认不带）──
  const sessionExport = await exportSessions({ home, outDir, mode: sessions, limit: sessionLimit })
  notes.push(...sessionExport.notes)
  let attachmentExport = { objects: 0, bytes: 0, notes: [], available: 0 }
  if (attachments) {
    attachmentExport = await exportAttachments({ home, outDir })
    notes.push(...attachmentExport.notes)
  }

  // ── 凭据层（只有给了密码才带；agent 永远拿不到密码）──
  let secretCount = 0
  if (password) {
    const collected = await collectSecrets(ctx, home)
    if (!collected.ok) {
      notes.push(`没有带走凭据：${collected.reason}`)
    } else if (collected.entries.length === 0) {
      notes.push('没有带走凭据：一条都没读到（可能都没配置）')
    } else {
      await writeSecrets(outDir, collected.entries, password)
      secretCount = collected.entries.length
      if (collected.skipped.length > 0) {
        notes.push(`有 ${collected.skipped.length} 条凭据读不到值，没有带走（名字不外泄，见设置页）`)
      }
    }
  }

  // ── 收尾 ──
  const full = await finalizePack(outDir, {
    kind: 'soul-export',
    createdAt: new Date().toISOString(),
    source: {
      home: toPosix(home),
      profile,
      dshVersion,
      nodeVersion: process.version,
      profiles: listProfileNames(home),
    },
    includes: {
      structure: true,
      config: settings.ok,
      custom: custom.length > 0,
      sessions: sessions !== 'none' && sessionExport.sessions.length > 0,
      attachments: attachments && attachmentExport.objects > 0,
      secrets: secretCount > 0,
      pluginPackages: localPacked > 0,
    },
    counts: {
      bundles: bundles.length,
      settingsNamespaces: Object.keys(settings.ok ? settings.namespaces : {}).length,
      patchLayers: patchLayers.length,
      customFiles: custom.length,
      localPlugins: localPacked,
      sessions: sessionExport.sessions.length,
      sessionBytes: sessionExport.bytes,
      attachments: attachmentExport.objects,
      secrets: secretCount,
    },
    notes,
  })

  return {
    ok: true,
    outDir,
    manifest: full,
    bytes: full.bytes,
    fileCount: full.fileCount,
    notes,
    bundles: bundles.length,
    settingsNamespaces: Object.keys(settings.ok ? settings.namespaces : {}).length,
    configExported: settings.ok,
    localPlugins: localPacked,
    sessions: sessionExport.sessions.length,
    attachments: attachmentExport.objects,
    secrets: secretCount,
  }
}

/** 导出目录的默认位置：`$DSH_HOME/dsh-mini-remote/souls/soul-<时间>`。 */
export function defaultExportDir(home) {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
  return join(home, 'dsh-mini-remote', 'souls', `soul-${stamp}`)
}

/** 读一段文本（给"体检"看 manifest 用）。 */
export async function readTextFile(abs) {
  try {
    return await readFile(abs, 'utf8')
  } catch {
    return null
  }
}
