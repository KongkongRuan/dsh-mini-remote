/**
 * 同步通道：本地目录 / 网盘目录（P6 第一条通道）。
 *
 * 为什么先做这条：它其实不需要协议——把灵魂包放进一个目录，网盘客户端自己会同步。
 * 代码最少，而"推、拉、比差异"这三件事的逻辑和以后接 Git / S3 是同一套，
 * 先在这里跑通，换传输层就只是换个 copy 实现。
 *
 * 三条从参考实现借来的判断（不是代码）：
 *   1. **先比哈希再动手**：manifest 一致就什么都不做，不做无谓的全量拷贝；
 *   2. **先写内容再写索引**：索引最后落盘，中途断掉时远端只是多一份没人指向的快照，
 *      而不是"索引说有、实际没有"；
 *   3. **保留有限份数**：默认只留最近 5 份，多出来的自动清掉，免得越堆越大。
 */
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { hashFile, hashText, listFilesDeep, toPosix, verifyPack } from './pack.js'

export const SYNC_FORMAT = 'dsh-soul-sync/1'
export const INDEX_FILE = 'index.json'
export const SNAPSHOT_DIR = 'snapshots'
export const DEFAULT_KEEP = 5

/** 包的内容指纹：拿 checksums.json 的哈希当身份。文件一变它就变。 */
export async function packFingerprint(packDir) {
  try {
    return await hashFile(join(packDir, 'integrity/checksums.json'))
  } catch {
    return null
  }
}

async function readIndex(targetDir) {
  try {
    const parsed = JSON.parse(await readFile(join(targetDir, INDEX_FILE), 'utf8'))
    if (Array.isArray(parsed?.snapshots)) return parsed
  } catch {
    // 没有索引：第一次推送，或这个目录不是我们建的。
  }
  return { format: SYNC_FORMAT, snapshots: [] }
}

/** 远端有什么：给界面看的一行摘要。 */
export async function inspectTarget(targetDir) {
  const index = await readIndex(targetDir)
  const latest = index.snapshots[0] ?? null
  return {
    ok: true,
    target: toPosix(targetDir),
    format: index.format ?? null,
    count: index.snapshots.length,
    latest,
    snapshots: index.snapshots.map((one) => ({
      id: one.id,
      createdAt: one.createdAt,
      bytes: one.bytes,
      fileCount: one.fileCount,
      profile: one.profile,
      dshVersion: one.dshVersion,
    })),
  }
}

/**
 * 把一份包推到目录里。
 *
 * @returns {Promise<{ok:boolean, skipped?:boolean, id?:string, reason?:string}>}
 */
export async function pushToDir({ packDir, targetDir, keep = DEFAULT_KEEP }) {
  const fingerprint = await packFingerprint(packDir)
  if (!fingerprint) return { ok: false, reason: '这个目录里没有完整的灵魂包（缺 integrity/checksums.json）' }

  const verify = await verifyPack(packDir)
  if (!verify.ok) return { ok: false, reason: `包校验不过，先别推：${verify.problems.slice(0, 2).join('；')}` }

  let manifest
  try {
    manifest = JSON.parse(await readFile(join(packDir, 'manifest.json'), 'utf8'))
  } catch (err) {
    return { ok: false, reason: `读不到 manifest.json（${err?.message ?? err}）` }
  }

  await mkdir(join(targetDir, SNAPSHOT_DIR), { recursive: true })
  const index = await readIndex(targetDir)
  const latest = index.snapshots[0]
  if (latest && latest.fingerprint === fingerprint) {
    return { ok: true, skipped: true, id: latest.id, reason: '远端已经是最新的一份，没有重复推' }
  }

  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
  const id = `soul-${stamp}`
  const dest = join(targetDir, SNAPSHOT_DIR, id)

  // 先写内容：拷完再落索引。顺序反了就会出现"索引说有、实际没有"。
  await rm(dest, { recursive: true, force: true })
  await cp(packDir, dest, { recursive: true })

  index.format = SYNC_FORMAT
  index.snapshots.unshift({
    id,
    createdAt: new Date().toISOString(),
    fingerprint,
    bytes: Number(manifest.bytes) || 0,
    fileCount: Number(manifest.fileCount) || 0,
    profile: manifest?.source?.profile ?? null,
    dshVersion: manifest?.source?.dshVersion ?? null,
  })

  // 只留最近 keep 份；多出来的连目录一起删。
  const dropped = index.snapshots.splice(keep)
  for (const gone of dropped) {
    await rm(join(targetDir, SNAPSHOT_DIR, gone.id), { recursive: true, force: true })
  }
  await writeFile(join(targetDir, INDEX_FILE), `${JSON.stringify(index, null, 2)}\n`, 'utf8')

  return { ok: true, id, fingerprint, dropped: dropped.map((d) => d.id), bytes: Number(manifest.bytes) || 0 }
}

/**
 * 从目录里拉一份回来。
 *
 * 拉回来落在 `$DSH_HOME/dsh-mini-remote/souls/pulled-<id>/`，**不直接覆盖现有包**；
 * 拿到之后照常走 soul_inspect / soul_plan / soul_apply，人还有机会看一眼。
 */
export async function pullFromDir({ targetDir, homeDir, which = '' }) {
  const index = await readIndex(targetDir)
  if (index.snapshots.length === 0) return { ok: false, reason: '这个目录里还没有任何灵魂包' }
  const chosen = which ? index.snapshots.find((one) => one.id === which) : index.snapshots[0]
  if (!chosen) return { ok: false, reason: `目录里没有 id 为 ${which} 的那一份` }

  const src = join(targetDir, SNAPSHOT_DIR, chosen.id)
  try {
    await stat(src)
  } catch {
    return { ok: false, reason: '索引里记着这一份，但目录里找不到（可能被手工删了）' }
  }

  const dest = join(homeDir, 'dsh-mini-remote', 'souls', `pulled-${chosen.id}`)
  await rm(dest, { recursive: true, force: true })
  await mkdir(dest, { recursive: true })
  await cp(src, dest, { recursive: true })

  const verify = await verifyPack(dest)
  if (!verify.ok) {
    return { ok: false, reason: `拉下来的包校验不过：${verify.problems.slice(0, 2).join('；')}`, dir: toPosix(dest) }
  }
  return { ok: true, dir: toPosix(dest), id: chosen.id, bytes: chosen.bytes, fileCount: chosen.fileCount }
}

/**
 * 比差异：本地这份包和远端最新那份是不是同一份。
 *
 * 只比指纹，不传内容——这是"要不要动"的判断，不是同步本身。
 */
export async function compareWithDir({ packDir, targetDir }) {
  const local = await packFingerprint(packDir)
  if (!local) return { ok: false, reason: '本地这个目录不是完整的灵魂包' }
  const index = await readIndex(targetDir)
  const latest = index.snapshots[0]
  if (!latest) return { ok: true, same: false, reason: '远端还没有任何一份' }
  return {
    ok: true,
    same: latest.fingerprint === local,
    remoteId: latest.id,
    remoteCreatedAt: latest.createdAt,
    remoteBytes: latest.bytes,
    reason: latest.fingerprint === local ? '两边是同一份' : '本地这份和远端最新那份不一样',
  }
}

export { hashText, listFilesDeep }
