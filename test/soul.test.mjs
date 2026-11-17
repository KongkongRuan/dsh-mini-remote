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

test('移魂技能：随包分发、有 frontmatter、并写进打包白名单', async () => {
  const { readFileSync } = await import('node:fs')
  const skill = readFileSync(new URL('../SKILL-soul.md', import.meta.url), 'utf8')
  assert.match(skill, /^---\r?\n/, '要有 frontmatter')
  assert.match(skill, /^name: dsh-mini-remote-soul$/m, '技能名要对')
  assert.match(skill, /^description: .+/m, '要有 description')

  // 操作规程里必须写清"哪些能搬、哪些不能"，否则模型会向用户过度承诺。
  assert.match(skill, /凭据/, '要讲凭据层不能搬')
  assert.match(skill, /不替用户重启/, '要写明不自动重启')

  const host = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(host, /SKILL-soul\.md/, '插件要读这个文件')
  assert.match(host, /name: 'dsh-mini-remote-soul'/, '要注册技能')

  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.ok(pkg.files.includes('SKILL-soul.md'), 'SKILL-soul.md 要在 files 白名单里，否则装完读不到')
})

/** 带安装能力的假 ctx：记录装/卸调用，模拟官方的 already-installed 语义。 */
function fakeCtxWithInstall({ bundles = [], versions = {} } = {}) {
  const state = {
    bundles: bundles.map((b) => ({ ...b, version: versions[b.name] ?? b.version ?? '1.0.0' })),
    installs: [],
    removes: [],
  }
  const services = {
    pluginManager: {
      listBundles: async () => state.bundles,
      setBundleEnabled: async (name, enabled) => {
        const item = state.bundles.find((b) => b.name === name)
        if (item) item.enabled = enabled
        return { changed: true, application: 'applied' }
      },
      installBundle: async (spec) => {
        state.installs.push(spec)
        const name = spec.includes('@') ? spec.slice(0, spec.lastIndexOf('@')) : spec
        if (state.bundles.some((b) => b.name === name)) {
          return { application: 'failed', error: { code: 'already-installed' } }
        }
        state.bundles.push({ name, installed: true, enabled: true, version: '9.9.9' })
        return { application: 'applied' }
      },
      removeBundle: async (name) => {
        state.removes.push(name)
        state.bundles = state.bundles.filter((b) => b.name !== name)
        return { application: 'applied' }
      },
      listVersionExemptions: async () => ({ runtimeVersion: '0.2.2-rc.3', exemptions: {}, warnings: [] }),
    },
    settings: {
      describeAll: async () => [],
      replace: async () => undefined,
    },
  }
  return { ctx: { get: (n) => services[n] }, state }
}

async function packWithBundles(root, bundles) {
  const pack = join(root, 'pack')
  await makePack(pack, { bundles, namespaces: {} })
  return pack
}

test('P2：目标机没装 → 计划里是 install，执行时真的去装', async () => {
  await withTemp(async (root) => {
    const home = join(root, 'home')
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    await writeFile(join(home, 'profiles', 'web', 'package.json'), '{}', 'utf8')
    const pack = await packWithBundles(root, [
      { name: 'pkg-a', installed: true, enabled: true, version: '1.2.3', spec: 'pkg-a@1.2.3' },
    ])

    const { ctx, state } = fakeCtxWithInstall({ bundles: [] })
    const plan = await planSoul({ packDir: pack, ctx, home, profile: 'web' })
    const item = plan.plan.items.find((i) => i.target === 'pkg-a')
    assert.equal(item.action, 'install')
    assert.equal(item.spec, 'pkg-a@1.2.3')
    assert.equal(plan.summary.install, 1)

    const applied = await applySoul({ packDir: pack, ctx, home, profile: 'web', planId: plan.planId, confirm: true })
    assert.equal(applied.ok, true, JSON.stringify(applied.notes))
    assert.deepEqual(state.installs, ['pkg-a@1.2.3'], '要按记录的 spec 去装')
  })
})

test('P2：版本不同 → 先卸再装', async () => {
  await withTemp(async (root) => {
    const home = join(root, 'home')
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    await writeFile(join(home, 'profiles', 'web', 'package.json'), '{}', 'utf8')
    const pack = await packWithBundles(root, [
      { name: 'pkg-b', installed: true, enabled: true, version: '2.0.0', spec: 'pkg-b@2.0.0' },
    ])
    const { ctx, state } = fakeCtxWithInstall({
      bundles: [{ name: 'pkg-b', installed: true, enabled: true }],
      versions: { 'pkg-b': '1.0.0' },
    })
    const plan = await planSoul({ packDir: pack, ctx, home, profile: 'web' })
    const item = plan.plan.items.find((i) => i.target === 'pkg-b')
    assert.equal(item.action, 'reinstall', '版本不同要走先卸再装')

    const applied = await applySoul({ packDir: pack, ctx, home, profile: 'web', planId: plan.planId, confirm: true })
    assert.equal(applied.ok, true, JSON.stringify(applied.notes))
    assert.deepEqual(state.removes, ['pkg-b'])
    assert.deepEqual(state.installs, ['pkg-b@2.0.0'])
  })
})

test('P2：回滚会把本次新装的包卸掉', async () => {
  await withTemp(async (root) => {
    const home = join(root, 'home')
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    await writeFile(join(home, 'profiles', 'web', 'package.json'), '{}', 'utf8')
    const pack = await packWithBundles(root, [
      { name: 'pkg-c', installed: true, enabled: true, version: '3.0.0', spec: 'pkg-c@3.0.0' },
    ])
    const { ctx, state } = fakeCtxWithInstall({ bundles: [] })
    const plan = await planSoul({ packDir: pack, ctx, home, profile: 'web' })
    const applied = await applySoul({ packDir: pack, ctx, home, profile: 'web', planId: plan.planId, confirm: true })
    assert.equal(applied.ok, true)

    const back = await rollbackSoul({ ctx, snapshotDir: applied.snapshotDir })
    assert.equal(back.ok, true, JSON.stringify(back.failed))
    assert.deepEqual(state.removes, ['pkg-c'])
  })
})

test('P2：already-installed 不算失败', async () => {
  await withTemp(async (root) => {
    const home = join(root, 'home')
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    await writeFile(join(home, 'profiles', 'web', 'package.json'), '{}', 'utf8')
    const pack = await packWithBundles(root, [
      { name: 'pkg-d', installed: true, enabled: true, version: '1.0.0', spec: 'pkg-d@1.0.0' },
    ])
    // 目标机的 listBundles 说没装，但 installBundle 回 already-installed —— 真实世界会这样。
    const { ctx } = fakeCtxWithInstall({
      bundles: [{ name: 'pkg-d', installed: true, enabled: true }],
      versions: { 'pkg-d': '1.0.0' },
    })
    // 让它被当成"没装"：把 installed 改成 false，但保留在列表里
    ctx.get('pluginManager').listBundles = async () => [{ name: 'pkg-d', installed: false, enabled: true, version: '1.0.0' }]
    const plan = await planSoul({ packDir: pack, ctx, home, profile: 'web' })
    const applied = await applySoul({ packDir: pack, ctx, home, profile: 'web', planId: plan.planId, confirm: true })
    assert.equal(applied.ok, true, JSON.stringify(applied.notes))
    const entry = applied.journal.find((j) => j.target === 'pkg-d')
    assert.equal(entry.result, 'skipped', 'already-installed 应记成跳过而不是失败')
  })
})
