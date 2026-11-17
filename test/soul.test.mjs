import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { finalizePack, readManifest, verifyPack, writeJsonFile, writeTextFile, hashText } from '../lib/soul/pack.js'
import { detectProfile, readProfileManifest } from '../lib/soul/env.js'
import { planSoul, applySoul, rollbackSoul, fingerprintOf } from '../lib/soul/migrate.js'

/**
 * 移魂 P1 的测试。
 *
 * 这一组不打桩"服务内部"，只打桩**宿主给的接口形状**（settings / pluginManager）。
 * 目的很明确：把"该跳过的跳过、该拒绝的拒绝"钉死——移魂最危险的失败不是报错，
 * 而是把不该写的东西安静地写进去。
 */

async function withTemp(fn) {
  const dir = await mkdtemp(join(tmpdir(), 'soul-test-'))
  try {
    return await fn(dir)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** 造一个假 ctx：只实现我们要用到的那些方法。 */
function fakeCtx({ bundles = [], namespaces = {} } = {}) {
  const state = {
    bundles: bundles.map((b) => ({ ...b })),
    namespaces: { ...namespaces },
    replaceCalls: [],
    enableCalls: [],
  }
  const services = {
    pluginManager: {
      listBundles: async () => state.bundles,
      setBundleEnabled: async (name, enabled) => {
        state.enableCalls.push([name, enabled])
        const item = state.bundles.find((b) => b.name === name)
        if (item) item.enabled = enabled
        return { changed: true, application: 'applied' }
      },
      listVersionExemptions: async () => ({ runtimeVersion: '0.2.2-rc.3', exemptions: {}, warnings: [] }),
    },
    settings: {
      describeAll: async () => Object.entries(state.namespaces).map(([ns, info]) => ({ ns, info })),
      replace: async (ns, value, revision) => {
        state.replaceCalls.push([ns, value, revision])
        const info = state.namespaces[ns]
        if (!info) throw new Error('no such namespace')
        if (revision !== info.revision) throw new Error('SettingsConflictError')
        state.namespaces[ns] = { value, revision: info.revision + 1 }
      },
    },
  }
  return { ctx: { get: (name) => services[name] }, state, services }
}

async function makePack(root, { bundles, namespaces, homePatch = '[]\n', profilePatch = '[]\n', agents = '# 规则\n' } = {}) {
  await writeJsonFile(root, 'profile/bundles.json', { profile: 'web', order: [], bundles })
  await writeJsonFile(root, 'profile/dependencies.json', {})
  await writeJsonFile(root, 'settings/namespaces.json', { namespaces })
  await writeTextFile(root, 'profile/patches/home.cordis.patch.yml', homePatch)
  await writeTextFile(root, 'profile/patches/profile.cordis.patch.yml', profilePatch)
  await writeTextFile(root, 'custom/AGENTS.md', agents)
  return finalizePack(root, {
    kind: 'soul-export',
    createdAt: new Date().toISOString(),
    source: { home: root, profile: 'web', dshVersion: '0.2.2-rc.3', nodeVersion: 'v24' },
    includes: { structure: true, config: true },
    counts: {},
  })
}

test('包：写完之后能读回，校验通过；改一个字节就报被改动', async () => {
  await withTemp(async (root) => {
    const pack = join(root, 'pack')
    await makePack(pack, { bundles: [], namespaces: {} })

    const read = await readManifest(pack)
    assert.equal(read.ok, true, '刚写完的包要能读')
    assert.equal(read.manifest.format, 'dsh-soul/1')

    const ok = await verifyPack(pack)
    assert.equal(ok.ok, true, `校验应通过：${ok.problems.join('；')}`)

    // 偷偷改一个字节
    const target = join(pack, 'custom/AGENTS.md')
    await writeFile(target, '# 改过\n', 'utf8')
    const bad = await verifyPack(pack)
    assert.equal(bad.ok, false)
    assert.ok(bad.problems.some((p) => p.includes('内容被改动过')), bad.problems.join('；'))
  })
})

test('包：少一个文件要算缺件，不能当"没人改过"', async () => {
  await withTemp(async (root) => {
    const pack = join(root, 'pack')
    await makePack(pack, { bundles: [], namespaces: {} })
    await rm(join(pack, 'custom/AGENTS.md'))
    const result = await verifyPack(pack)
    assert.equal(result.ok, false)
    assert.ok(result.problems.some((p) => p.startsWith('缺件')), result.problems.join('；'))
  })
})

test('包：不是移魂包要明确拒绝，而不是读出一堆 undefined', async () => {
  await withTemp(async (root) => {
    const pack = join(root, 'pack')
    await mkdir(pack, { recursive: true })
    await writeFile(join(pack, 'manifest.json'), JSON.stringify({ format: 'other/1' }), 'utf8')
    const read = await readManifest(pack)
    assert.equal(read.ok, false)
    assert.match(read.error, /不是移魂包/)
  })
})

test('档案：只有一个档案时直接用，不用猜', async () => {
  await withTemp(async (home) => {
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    await writeFile(join(home, 'profiles', 'web', 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['a'] } } }), 'utf8')
    const got = detectProfile(home, [], '')
    assert.equal(got.name, 'web')
  })
})

test('档案：多个档案按启动 bundle 命中判定，平手就要求指定', async () => {
  await withTemp(async (home) => {
    for (const [name, bundles] of [['web', ['a', 'b', 'c']], ['desktop', ['a', 'x']]]) {
      await mkdir(join(home, 'profiles', name), { recursive: true })
      await writeFile(join(home, 'profiles', name, 'package.json'), JSON.stringify({ dsh: { profile: { bundles } } }), 'utf8')
    }
    const hit = detectProfile(home, ['a', 'b', 'c'], '')
    assert.equal(hit.name, 'web', hit.reason)

    const tie = detectProfile(home, ['a'], '')
    assert.equal(tie.name, null, '平手不能瞎猜')
    assert.deepEqual(tie.candidates.sort(), ['desktop', 'web'])
  })
})

test('档案：显式指定但不存在时如实拒绝', async () => {
  await withTemp(async (home) => {
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    await writeFile(join(home, 'profiles', 'web', 'package.json'), '{}', 'utf8')
    const got = detectProfile(home, [], 'nope')
    assert.equal(got.name, null)
    assert.match(got.reason, /不存在/)
  })
})

test('计划：目标机没装的插件只跳过、不假装能装', async () => {
  await withTemp(async (root) => {
    const home = join(root, 'home')
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    await writeFile(join(home, 'profiles', 'web', 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }), 'utf8')
    const pack = join(root, 'pack')
    await makePack(pack, {
      bundles: [
        { name: 'installed-but-off', installed: true, enabled: false },
        { name: 'not-installed', installed: false, enabled: true },
        { name: 'already-on', installed: true, enabled: true },
      ],
      namespaces: {},
    })
    // 目标机：一个装了但没启用、一个已经开着；第三个压根没装。
    const { ctx } = fakeCtx({
      bundles: [
        { name: 'installed-but-off', installed: true, enabled: false },
        { name: 'already-on', installed: true, enabled: true },
      ],
    })
    const plan = await planSoul({ packDir: pack, ctx, home, profile: 'web' })
    assert.equal(plan.ok, true)
    const byName = new Map(plan.plan.items.map((i) => [i.target, i.action]))
    assert.equal(byName.get('installed-but-off'), 'enable')
    assert.equal(byName.get('not-installed'), 'skip', 'P1 不装包，必须跳过')
    assert.equal(byName.get('already-on'), 'noop')
    assert.equal(plan.summary.skip, 1)
  })
})

test('计划：目标机没有的配置条目跳过；值不同才 replace', async () => {
  await withTemp(async (root) => {
    const home = join(root, 'home')
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    await writeFile(join(home, 'profiles', 'web', 'package.json'), '{}', 'utf8')
    const pack = join(root, 'pack')
    await makePack(pack, {
      bundles: [],
      namespaces: {
        'same-entry': { value: { a: 1 }, revision: 1 },
        'changed-entry': { value: { b: 2 }, revision: 1 },
        'missing-entry': { value: { c: 3 }, revision: 1 },
      },
    })
    const { ctx } = fakeCtx({
      namespaces: {
        'same-entry': { value: { a: 1 }, revision: 5 },
        'changed-entry': { value: { b: 1 }, revision: 5 },
      },
    })
    const plan = await planSoul({ packDir: pack, ctx, home, profile: 'web' })
    const byName = new Map(plan.plan.items.map((i) => [i.target, i.action]))
    assert.equal(byName.get('same-entry'), 'noop')
    assert.equal(byName.get('changed-entry'), 'replace')
    assert.equal(byName.get('missing-entry'), 'skip', '条目不存在就写不进去，必须跳过')
  })
})

test('执行：不带 confirm 一律拒绝，且零写入', async () => {
  await withTemp(async (root) => {
    const home = join(root, 'home')
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    await writeFile(join(home, 'profiles', 'web', 'package.json'), '{}', 'utf8')
    const pack = join(root, 'pack')
    await makePack(pack, { bundles: [], namespaces: {} })
    const { ctx, state } = fakeCtx({})
    const result = await applySoul({ packDir: pack, ctx, home, profile: 'web', confirm: false })
    assert.equal(result.ok, false)
    assert.match(result.error, /确认/)
    assert.equal(state.replaceCalls.length, 0)
  })
})

test('执行：planId 对不上就整笔拒绝（计划变了不写）', async () => {
  await withTemp(async (root) => {
    const home = join(root, 'home')
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    await writeFile(join(home, 'profiles', 'web', 'package.json'), '{}', 'utf8')
    const pack = join(root, 'pack')
    await makePack(pack, { bundles: [], namespaces: { ns: { value: { a: 1 }, revision: 1 } } })
    const { ctx, state } = fakeCtx({ namespaces: { ns: { value: { a: 0 }, revision: 1 } } })
    const result = await applySoul({ packDir: pack, ctx, home, profile: 'web', planId: 'stale-id', confirm: true })
    assert.equal(result.ok, false)
    assert.match(result.error, /计划已经变了/)
    assert.equal(state.replaceCalls.length, 0, '拒绝时必须零写入')
  })
})

test('执行：写完能回滚，文件与配置都退回去', async () => {
  await withTemp(async (root) => {
    const home = join(root, 'home')
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    await writeFile(join(home, 'profiles', 'web', 'package.json'), '{}', 'utf8')
    await writeFile(join(home, 'AGENTS.md'), '# 旧规则\n', 'utf8')

    const pack = join(root, 'pack')
    await makePack(pack, {
      bundles: [],
      namespaces: { ns: { value: { a: 2 }, revision: 1 } },
      agents: '# 新规则\n',
    })
    const { ctx, state } = fakeCtx({ namespaces: { ns: { value: { a: 1 }, revision: 1 } } })

    const plan = await planSoul({ packDir: pack, ctx, home, profile: 'web' })
    const applied = await applySoul({ packDir: pack, ctx, home, profile: 'web', planId: plan.planId, confirm: true })
    assert.equal(applied.ok, true, JSON.stringify(applied.notes))
    assert.equal(await readFile(join(home, 'AGENTS.md'), 'utf8'), '# 新规则\n')
    assert.deepEqual(state.namespaces.ns.value, { a: 2 })

    const back = await rollbackSoul({ ctx, snapshotDir: applied.snapshotDir })
    assert.equal(back.ok, true, JSON.stringify(back.failed))
    assert.equal(await readFile(join(home, 'AGENTS.md'), 'utf8'), '# 旧规则\n')
    assert.deepEqual(state.namespaces.ns.value, { a: 1 }, '配置要退回旧值')
  })
})

test('指纹：同样的变更集算出同一个指纹，动作一变就变', () => {
  const a = fingerprintOf([{ id: 'x', action: 'replace', target: 'ns' }])
  const b = fingerprintOf([{ id: 'x', action: 'replace', target: 'ns' }])
  const c = fingerprintOf([{ id: 'x', action: 'create', target: 'ns' }])
  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.equal(a.length, 64, '指纹应是 sha256 十六进制')
})
