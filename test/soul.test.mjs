import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
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

// ---------------------------------------------------------------------------
// 本地源插件（link:/file:/裸路径）的打包与安装
// ---------------------------------------------------------------------------

test('本地源识别：link:/file:/裸路径算本地，name@version 不算', async () => {
  const { isLocalSpec } = await import('../lib/soul/local-plugin.js')
  assert.equal(isLocalSpec('link:../my-plugin'), true)
  assert.equal(isLocalSpec('file:./pack.tgz'), true)
  assert.equal(isLocalSpec('I:/极简遥控器/极简遥控器'), true)
  assert.equal(isLocalSpec('./local'), true)
  assert.equal(isLocalSpec('dsh-mini-remote@0.3.0'), false, '注册表 spec 不该当成本地')
  assert.equal(isLocalSpec('@scope/name'), false)
})

test('本地插件：导出时打成 tarball 进包，bundles.json 记下可用的相对路径', async () => {
  await withTemp(async (root) => {
    const home = join(root, 'home')
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    await writeFile(
      join(home, 'profiles', 'web', 'package.json'),
      JSON.stringify({ dsh: { profile: { bundles: ['my-local-plugin'] } } }),
      'utf8',
    )
    const pluginDir = join(root, 'my-local-plugin')
    await mkdir(pluginDir, { recursive: true })
    await writeFile(join(pluginDir, 'package.json'), JSON.stringify({ name: 'my-local-plugin', version: '1.0.0' }), 'utf8')

    const pack = join(root, 'pack')
    // 假 ctx：只有 pluginManager 报告这个包，来源是 link: 指向本地目录。
    const ctx = {
      get: (name) =>
        name === 'pluginManager'
          ? {
              listBundles: async () => [
                { name: 'my-local-plugin', installed: true, enabled: true, version: '1.0.0', installTarget: { spec: `link:${pluginDir}` } },
              ],
              listVersionExemptions: async () => ({ runtimeVersion: '0.2.2-rc.3' }),
            }
          : undefined,
    }
    // 注入假 npm pack：真的不应该在单测里跑包管理器。
    const fakeRunPack = async ({ outDir }) => {
      const produced = join(outDir, 'my-local-plugin-1.0.0.tgz')
      await writeFile(produced, 'fake-tarball-bytes', 'utf8')
      return produced
    }
    const { exportSoul } = await import('../lib/soul/export.js')
    const result = await exportSoul({ ctx, home, profile: 'web', outDir: pack, runPack: fakeRunPack })
    assert.equal(result.ok, true)
    assert.equal(result.localPlugins, 1)

    const bundles = JSON.parse(await readFile(join(pack, 'profile/bundles.json'), 'utf8'))
    const entry = bundles.bundles.find((b) => b.name === 'my-local-plugin')
    assert.equal(entry.specKind, 'local')
    assert.equal(entry.localTarball, 'plugins/local/my-local-plugin.tgz')
    // tarball 真的在包里，而且被算进校验和。
    const verify = await verifyPack(pack)
    assert.equal(verify.ok, true, verify.problems.join('；'))
    assert.ok(Object.keys(JSON.parse(await readFile(join(pack, 'integrity/checksums.json'), 'utf8')).files).includes('plugins/local/my-local-plugin.tgz'))
  })
})

test('本地插件：打包失败要如实记 note，不能假装带上了', async () => {
  await withTemp(async (root) => {
    const home = join(root, 'home')
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    await writeFile(
      join(home, 'profiles', 'web', 'package.json'),
      JSON.stringify({ dsh: { profile: { bundles: ['gone'] } } }),
      'utf8',
    )
    const ctx = {
      get: (name) =>
        name === 'pluginManager'
          ? {
              listBundles: async () => [
                { name: 'gone', installed: true, enabled: true, version: '1.0.0', installTarget: { spec: 'link:Z:/does-not-exist' } },
              ],
              listVersionExemptions: async () => ({ runtimeVersion: '0.2.2-rc.3' }),
            }
          : undefined,
    }
    const pack = join(root, 'pack')
    const { exportSoul } = await import('../lib/soul/export.js')
    const result = await exportSoul({ ctx, home, profile: 'web', outDir: pack })
    assert.equal(result.ok, true)
    assert.equal(result.localPlugins, 0)
    assert.ok(result.notes.some((n) => n.includes('gone') && n.includes('没打包')), result.notes.join('；'))
  })
})

test('本地插件：导入时 tarball 落到本机，装的是 file: 绝对路径', async () => {
  await withTemp(async (root) => {
    const home = join(root, 'home')
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    await writeFile(join(home, 'profiles', 'web', 'package.json'), '{}', 'utf8')

    const pack = join(root, 'pack')
    await makePack(pack, {
      bundles: [
        {
          name: 'local-thing',
          installed: true,
          enabled: true,
          version: '1.0.0',
          spec: 'link:Z:/nowhere',
          specKind: 'local',
          localTarball: 'plugins/local/local-thing.tgz',
        },
      ],
      namespaces: {},
    })
    await mkdir(join(pack, 'plugins/local'), { recursive: true })
    await writeFile(join(pack, 'plugins/local/local-thing.tgz'), 'bytes', 'utf8')
    // 重新收尾，让新加的 tarball 进校验和。
    const { finalizePack } = await import('../lib/soul/pack.js')
    await finalizePack(pack, { kind: 'soul-export', source: { profile: 'web', dshVersion: '0.2.2-rc.3' }, includes: {}, counts: {} })

    const { ctx, state } = fakeCtxWithInstall({ bundles: [] })
    const plan = await planSoul({ packDir: pack, ctx, home, profile: 'web' })
    const item = plan.plan.items.find((i) => i.target === 'local-thing')
    assert.equal(item.action, 'install')
    assert.equal(item.localTarball, 'plugins/local/local-thing.tgz')

    const applied = await applySoul({ packDir: pack, ctx, home, profile: 'web', planId: plan.planId, confirm: true })
    assert.equal(applied.ok, true, JSON.stringify(applied.notes))
    assert.equal(state.installs.length, 1)
    assert.match(state.installs[0], /^file:.*souls\/imported\/local-thing\/local-thing\.tgz$/, state.installs[0])
  })
})

test('本地插件：真跑一次 npm pack（没有包管理器就跳过）', async (t) => {
  await withTemp(async (root) => {
    const dir = join(root, 'fixture')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'package.json'), JSON.stringify({ name: 'fixture-plugin', version: '0.1.0', main: 'index.js' }), 'utf8')
    await writeFile(join(dir, 'index.js'), 'export const x = 1\n', 'utf8')

    const { packLocalPlugin } = await import('../lib/soul/local-plugin.js')
    const result = await packLocalPlugin({
      name: 'fixture-plugin',
      spec: `link:${dir}`,
      home: root,
      outRoot: join(root, 'pack'),
    })
    if (!result.ok) {
      // 机器上没有 npm/pnpm 时如实跳过，而不是把测试变红。
      t.skip(`这台机器打不了包：${result.reason}`)
      return
    }
    assert.equal(result.rel, 'plugins/local/fixture-plugin.tgz')
    const info = await stat(join(root, 'pack', result.rel))
    assert.ok(info.size > 0, 'tarball 不能是空文件')
  })
})

// ---------------------------------------------------------------------------
// P3：会话日志（多帧 zstd）与附件
// ---------------------------------------------------------------------------

import { zstdCompressSync, zstdDecompressSync } from 'node:zlib'
import { firstFrameLength, readHeader, rewriteHeaderCwd, projectKeyOf } from '../lib/soul/session-log.js'
import { applyPathMap } from '../lib/soul/sessions.js'

/** 造一份"头部 + 若干事件"的多帧日志，模拟真实会话文件。 */
function makeSessionLog(cwd, events = ['{"type":"user/message"}', '{"type":"turn/end"}']) {
  const header = zstdCompressSync(Buffer.from(`${JSON.stringify({ type: 'session', version: 4, id: 's1', cwd })}\n`, 'utf8'))
  const frames = events.map((line) => zstdCompressSync(Buffer.from(`${line}\n`, 'utf8')))
  return { buffer: Buffer.concat([header, ...frames]), frameCount: 1 + frames.length }
}

test('会话日志：能认出多帧，第一帧就是头部', () => {
  const { buffer } = makeSessionLog('C:\\old\\place')
  const length = firstFrameLength(buffer)
  assert.ok(length > 0 && length < buffer.length, '第一帧应当只是开头一段')
  const header = readHeader(buffer)
  assert.equal(header.cwd, 'C:\\old\\place')
  assert.equal(header.type, 'session')
})

test('会话日志：只改第一帧的 cwd，后面几帧逐字节不变', () => {
  const { buffer } = makeSessionLog('C:\\old\\place')
  const firstLen = firstFrameLength(buffer)
  const tailBefore = buffer.subarray(firstLen)

  const result = rewriteHeaderCwd(buffer, 'D:\\new\\place')
  assert.equal(result.ok, true, result.reason)
  assert.equal(readHeader(result.buffer).cwd, 'D:\\new\\place')

  const newFirstLen = firstFrameLength(result.buffer)
  const tailAfter = result.buffer.subarray(newFirstLen)
  assert.deepEqual(tailAfter, tailBefore, '第二帧起必须原样保留')

  // 第二帧仍然能独立解开
  const second = zstdDecompressSync(tailAfter).toString('utf8')
  assert.match(second, /user\/message/)
})

test('会话日志：cwd 已经一样就不动它', () => {
  const { buffer } = makeSessionLog('C:\\same')
  const result = rewriteHeaderCwd(buffer, 'C:\\same')
  assert.equal(result.ok, true)
  assert.equal(result.reason, '无需改写')
  assert.deepEqual(result.buffer, buffer)
})

test('会话目录名：按真实规则由路径生成', () => {
  assert.equal(projectKeyOf('C:\\Users\\WINDOWS'), '--C-Users-WINDOWS--')
  assert.equal(projectKeyOf('D:\\X\\X'), '--D-X-X--')
  assert.equal(projectKeyOf('C:\\Users\\WINDOWS\\.dsh\\profiles\\desktop'), '--C-Users-WINDOWS-.dsh-profiles-desktop--')
  assert.equal(projectKeyOf('I:\\极简遥控器\\极简遥控器\\'), '--I-极简遥控器-极简遥控器--')
  assert.equal(projectKeyOf(''), null)
})

test('路径映射：按段边界，不会把 极简遥控器2 当成 极简遥控器', () => {
  const maps = [{ oldPrefix: 'I:\\极简遥控器', newPrefix: 'D:\\work' }]
  assert.equal(applyPathMap('I:\\极简遥控器\\a\\b', maps), 'D:/work/a/b')
  assert.equal(applyPathMap('I:\\极简遥控器2\\a', maps), 'I:\\极简遥控器2\\a', '多一个字符就是另一个目录')
  assert.equal(applyPathMap('I:\\极简遥控器', maps), 'D:/work')
  assert.equal(applyPathMap('E:\\other', maps), 'E:\\other', '没命中就保持原样')
})

test('P3：两端版本不同时，会话整项跳过并说清原因', async () => {
  await withTemp(async (root) => {
    const home = join(root, 'home')
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    await writeFile(join(home, 'profiles', 'web', 'package.json'), '{}', 'utf8')

    const pack = join(root, 'pack')
    await makePack(pack, { bundles: [], namespaces: {} })
    // 来源版本写成另一个版本
    const manifest = JSON.parse(await readFile(join(pack, 'manifest.json'), 'utf8'))
    manifest.source.dshVersion = '0.1.0-ancient'
    manifest.includes = { structure: true, config: true, sessions: true }
    await mkdir(join(pack, 'sessions/--C-old--/session-a'), { recursive: true })
    await writeFile(
      join(pack, 'sessions/index.json'),
      JSON.stringify({ count: 1, bytes: 10, sessions: [{ projectKey: '--C-old--', sessionId: 'session-a', cwd: 'C:\\old', files: [] }] }),
      'utf8',
    )
    await writeFile(join(pack, 'manifest.json'), JSON.stringify(manifest), 'utf8')
    const { finalizePack } = await import('../lib/soul/pack.js')
    await finalizePack(pack, manifest)

    const { ctx } = fakeCtxWithInstall({ bundles: [] }) // 这份假 ctx 的运行时版本是 0.2.2-rc.3
    const plan = await planSoul({ packDir: pack, ctx, home, profile: 'web' })
    const item = plan.plan.items.find((i) => i.id === 'sessions:version')
    assert.ok(item, '要有一条版本不一致的说明')
    assert.equal(item.action, 'skip')
    assert.match(item.detail, /版本不同/)
    assert.equal(plan.plan.items.filter((i) => i.kind === 'session' && i.action === 'create').length, 0)
  })
})

test('P3：目标机已有同 id 会话就跳过，绝不覆盖', async () => {
  await withTemp(async (root) => {
    const home = join(root, 'home')
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    await writeFile(join(home, 'profiles', 'web', 'package.json'), '{}', 'utf8')
    // 目标机已有同名会话
    await mkdir(join(home, 'sessions', '--C-old--', 'session-a'), { recursive: true })
    await writeFile(join(home, 'sessions', '--C-old--', 'session-a', 'session.jsonl.zstd'), 'mine', 'utf8')

    const pack = join(root, 'pack')
    const { buffer } = makeSessionLog('C:\\old')
    await makePack(pack, { bundles: [], namespaces: {} })
    await mkdir(join(pack, 'sessions/--C-old--/session-a'), { recursive: true })
    await writeFile(join(pack, 'sessions/--C-old--/session-a/session.jsonl.zstd'), buffer)
    await writeFile(
      join(pack, 'sessions/index.json'),
      JSON.stringify({ count: 1, bytes: buffer.length, sessions: [{ projectKey: '--C-old--', sessionId: 'session-a', cwd: 'C:\\old', files: ['session.jsonl.zstd'] }] }),
      'utf8',
    )
    const { finalizePack } = await import('../lib/soul/pack.js')
    const manifest = JSON.parse(await readFile(join(pack, 'manifest.json'), 'utf8'))
    await finalizePack(pack, manifest)

    const { ctx } = fakeCtxWithInstall({ bundles: [] })
    const plan = await planSoul({ packDir: pack, ctx, home, profile: 'web' })
    const item = plan.plan.items.find((i) => i.target === '--C-old--/session-a')
    assert.equal(item.action, 'skip')
    assert.match(item.detail, /不覆盖/)
  })
})

test('P3：导入会话时按映射改 cwd，并落到新目录名下', async () => {
  await withTemp(async (root) => {
    const home = join(root, 'home')
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    await writeFile(join(home, 'profiles', 'web', 'package.json'), '{}', 'utf8')

    const { buffer } = makeSessionLog('I:\\旧盘\\项目')
    const pack = join(root, 'pack')
    await makePack(pack, { bundles: [], namespaces: {} })
    await mkdir(join(pack, 'sessions/--I-旧盘-项目--/session-a'), { recursive: true })
    await writeFile(join(pack, 'sessions/--I-旧盘-项目--/session-a/session.jsonl.zstd'), buffer)
    await writeFile(
      join(pack, 'sessions/index.json'),
      JSON.stringify({
        count: 1,
        bytes: buffer.length,
        sessions: [{ projectKey: '--I-旧盘-项目--', sessionId: 'session-a', cwd: 'I:\\旧盘\\项目', files: ['session.jsonl.zstd'] }],
      }),
      'utf8',
    )
    const { finalizePack } = await import('../lib/soul/pack.js')
    const manifest = JSON.parse(await readFile(join(pack, 'manifest.json'), 'utf8'))
    await finalizePack(pack, manifest)

    const { ctx } = fakeCtxWithInstall({ bundles: [] })
    const maps = [{ oldPrefix: 'I:\\旧盘', newPrefix: 'D:\\new' }]
    const plan = await planSoul({ packDir: pack, ctx, home, profile: 'web', pathMap: maps })
    assert.equal(plan.ok, true, plan.error)
    const applied = await applySoul({ packDir: pack, ctx, home, profile: 'web', planId: plan.planId, confirm: true, pathMap: maps })
    assert.equal(applied.ok, true, JSON.stringify(applied.notes))

    const destLog = join(home, 'sessions', projectKeyOf('D:\\new\\项目'), 'session-a', 'session.jsonl.zstd')
    const written = await readFile(destLog)
    assert.equal(readHeader(written).cwd.replace(/\\/g, '/'), 'D:/new/项目')

    // 回滚要把这次新建的会话删掉
    const back = await rollbackSoul({ ctx, snapshotDir: applied.snapshotDir })
    assert.equal(back.ok, true, JSON.stringify(back.failed))
    const { existsSync } = await import('node:fs')
    assert.equal(existsSync(destLog), false, '回滚后不该留下会话文件')
  })
})

test('P3：附件按内容寻址补齐，已有的不重写；回滚只删新增', async () => {
  await withTemp(async (root) => {
    const home = join(root, 'home')
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    await writeFile(join(home, 'profiles', 'web', 'package.json'), '{}', 'utf8')
    // 目标机已经有一个附件对象
    await mkdir(join(home, 'attachments/v1/objects/aa'), { recursive: true })
    await writeFile(join(home, 'attachments/v1/objects/aa/hash1'), 'old', 'utf8')

    const pack = join(root, 'pack')
    await makePack(pack, { bundles: [], namespaces: {} })
    await mkdir(join(pack, 'attachments/v1/objects/aa'), { recursive: true })
    await mkdir(join(pack, 'attachments/v1/objects/bb'), { recursive: true })
    await writeFile(join(pack, 'attachments/v1/objects/aa/hash1'), 'new', 'utf8')
    await writeFile(join(pack, 'attachments/v1/objects/bb/hash2'), 'brand-new', 'utf8')
    const { finalizePack } = await import('../lib/soul/pack.js')
    const manifest = JSON.parse(await readFile(join(pack, 'manifest.json'), 'utf8'))
    await finalizePack(pack, manifest)

    const { ctx } = fakeCtxWithInstall({ bundles: [] })
    const plan = await planSoul({ packDir: pack, ctx, home, profile: 'web' })
    const applied = await applySoul({ packDir: pack, ctx, home, profile: 'web', planId: plan.planId, confirm: true })
    assert.equal(applied.ok, true, JSON.stringify(applied.notes))

    assert.equal(await readFile(join(home, 'attachments/v1/objects/aa/hash1'), 'utf8'), 'old', '已存在的不覆盖')
    assert.equal(await readFile(join(home, 'attachments/v1/objects/bb/hash2'), 'utf8'), 'brand-new')

    const back = await rollbackSoul({ ctx, snapshotDir: applied.snapshotDir })
    assert.equal(back.ok, true, JSON.stringify(back.failed))
    const { existsSync } = await import('node:fs')
    assert.equal(existsSync(join(home, 'attachments/v1/objects/bb/hash2')), false, '新增的要删掉')
    assert.equal(existsSync(join(home, 'attachments/v1/objects/aa/hash1')), true, '原有的不能动')
  })
})

test('设置页：移魂面板存在、默认收起、写入动作要二次确认', async () => {
  const { readFileSync } = await import('node:fs')
  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.match(client, /function soulBlock\(/, '要有面板渲染函数')
  assert.match(client, /settingsGroup\('soul', '移魂大法'/, '要在设置页注册这一组')
  assert.match(client, /var soulGroupState = useState\(false\)/, '默认收起')
  assert.match(client, /confirmApply/, '执行前要二次确认')
  assert.match(client, /confirmRollback/, '回滚前要二次确认')
  // 面板必须说清"凭据不搬"，这是用户最容易误会的一条。
  assert.match(client, /凭据一起带（API Key 等，需要你自己设一个密码）/, '要说明凭据可选、要密码')
})

test('设置页：五条接口都在，写入的两条各自要求 confirm', async () => {
  const { readFileSync } = await import('node:fs')
  const routes = readFileSync(new URL('../lib/soul/routes.js', import.meta.url), 'utf8')
  for (const path of ['export', 'inspect', 'plan', 'apply', 'rollback']) {
    assert.match(routes, new RegExp(`'/mini-remote/soul/${path}'`), `缺少 /${path} 路由`)
  }
  assert.match(routes, /body\.confirm !== true/, 'apply 要在服务端校验 confirm，不能只靠界面点两下')
  assert.match(routes, /localOnly\(req, res\)/, '五条都要只认同机')

  const host = readFileSync(new URL('../lib/index.js', import.meta.url), 'utf8')
  assert.match(host, /registerSoulRoutes/, '插件要把路由挂上')
})

test('设置页：移魂这一组的 children 必须传数组，否则整组被静默丢掉', async () => {
  const { readFileSync } = await import('node:fs')
  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  // settingsGroup 开头是 `if (!children.length) return null`：单个元素没有 length，
  // 传错了不会报错，只会"什么都没显示"——这条测试专门钉住它。
  assert.match(client, /settingsGroup\('soul', '移魂大法', groups\.soulOpen, groups\.toggleSoul,\s*\[soulBlock\(/, '要传数组')
  assert.match(client, /if \(!children\.length\) return null/, '前提没变')
})

// ---------------------------------------------------------------------------
// P4：凭据通道（加密）
// ---------------------------------------------------------------------------

import { encryptSecrets, decryptSecrets, listSecretRefs, applySecrets } from '../lib/soul/secrets.js'

test('凭据：加密后看不到明文，密码对了才能解回', () => {
  const entries = [{ ref: 'DEEPSEEK_API_KEY', value: 'sk-very-secret-value' }]
  const blob = encryptSecrets(entries, 'hunter2hunter2')
  const text = blob.toString('latin1')
  assert.equal(text.includes('sk-very-secret-value'), false, '密文里不能出现明文')
  assert.equal(text.includes('DEEPSEEK_API_KEY'), false, '连 ref 名也不该是明文')

  const back = decryptSecrets(blob, 'hunter2hunter2')
  assert.deepEqual(back, entries)
})

test('凭据：密码不对要明确报错，不能返回空数据', () => {
  const blob = encryptSecrets([{ ref: 'A', value: 'x' }], 'password1')
  assert.throws(() => decryptSecrets(blob, 'password2'), /密码不对/)
})

test('凭据：改一个字节就解不开（GCM 会拒绝）', () => {
  const blob = encryptSecrets([{ ref: 'A', value: 'x' }], 'password1')
  const tampered = Buffer.from(blob)
  tampered[tampered.length - 1] ^= 0xff
  assert.throws(() => decryptSecrets(tampered, 'password1'), /密码不对|被改过/)
})

test('凭据：短密码不许用', () => {
  assert.throws(() => encryptSecrets([{ ref: 'A', value: 'x' }], '123'), /至少 6 位/)
})

test('凭据：ref 名单从 .credentials.yaml 的 refs 段读，不碰值', async () => {
  await withTemp(async (home) => {
    await writeFile(
      join(home, '.credentials.yaml'),
      ['version: 1', 'records:', 'refs:', '  AAA_KEY: { value: secret-a }', '  BBB_KEY:', '    value: secret-b', 'other:', '  CCC: 1', ''].join('\n'),
      'utf8',
    )
    assert.deepEqual(await listSecretRefs(home), ['AAA_KEY', 'BBB_KEY'])
  })
})

test('凭据：写入逐条报告，一条失败不影响其它', async () => {
  const calls = []
  const ctx = {
    get: (name) =>
      name === 'credentials'
        ? {
            set: async (ref, value) => {
              calls.push([ref, value])
              if (ref === 'BAD') throw new Error('nope')
            },
          }
        : undefined,
  }
  const result = await applySecrets(ctx, [{ ref: 'OK1', value: 'a' }, { ref: 'BAD', value: 'b' }, { ref: 'OK2', value: 'c' }])
  assert.equal(result.ok, false)
  assert.deepEqual(result.written, ['OK1', 'OK2'])
  assert.equal(result.failed[0].ref, 'BAD')
})

test('凭据：agent 工具明确拒收密码，并指路设置页', async () => {
  const { readFileSync } = await import('node:fs')
  const tools = readFileSync(new URL('../lib/soul/tools.js', import.meta.url), 'utf8')
  assert.match(tools, /这个工具不接受密码/, '要在执行前挡掉')
  assert.match(tools, /设置 → 遥控设置 → 移魂大法/, '要告诉用户去哪里')
  // 参数表里不许出现 password
  const params = tools.slice(tools.indexOf('const tools = ['), tools.indexOf('for (const tool of tools)'))
  assert.equal(/password:/.test(params), false, '工具参数里不能有 password')
})

test('打开目录：只认 DSH 自己的目录，且不存在要如实说', async () => {
  const { registerSoulRoutes } = await import('../lib/soul/routes.js')
  const { resolveHome } = await import('../lib/soul/env.js')
  const seen = []
  const handlers = new Map()
  registerSoulRoutes({
    ctx: { get: () => undefined },
    mountRoute: ({ path, handler }) => {
      handlers.set(path, handler)
      return () => {}
    },
    localOnly: () => true,
    readBody: async (req) => req.body,
    sendJson: (_res, status, payload) => seen.push({ status, payload }),
    log: { warn: () => {} },
  })
  const handler = handlers.get('/mini-remote/soul/open-folder')
  assert.ok(handler, '要注册这条路由')

  // ① 系统目录：拒绝（这条路由不是"打开任何路径"的通用入口）
  await handler({ method: 'POST', body: { path: 'C:\\Windows' } }, {})
  assert.equal(seen.pop().status, 400)

  // ② DSH 目录里但不存在的：404
  await handler({ method: 'POST', body: { path: join(resolveHome(), 'no-such-dir-here') } }, {})
  assert.equal(seen.pop().status, 404)

  // ③ 只接受 POST
  await handler({ method: 'GET', body: {} }, {})
  assert.equal(seen.pop().status, 405)
})

test('设置页：导出结果里的目录可以点开', async () => {
  const { readFileSync } = await import('node:fs')
  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.match(client, /open-folder/, '要调那条接口')
  assert.match(client, /dirLink\(b\.outDir\)/, '导出目录要能点')
  assert.match(client, /dirLink\(ap\.snapshotDir\)/, '快照目录也要能点')
})

test('配置：没有 describeAll 时退回按 settings.yaml 的键名逐个问', async () => {
  await withTemp(async (root) => {
    const home = join(root, 'home')
    await mkdir(join(home, 'profiles', 'web'), { recursive: true })
    await writeFile(join(home, 'profiles', 'web', 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }), 'utf8')
    // 真机就是这份文件：已经被导入进 profile patch，内容不等于生效值，但键名还能用。
    await writeFile(join(home, 'settings.yaml'), ['llm-deepseek:', '  apiKey: x', 'skin:', '  name: dark', 'broken-entry:', '  a: 1', ''].join('\n'), 'utf8')

    const asked = []
    const ctx = {
      get: (name) =>
        name === 'settings'
          ? {
              // 故意不给 describeAll
              describe: async (ns) => {
                asked.push(ns)
                if (ns === 'broken-entry') throw new Error('条目不存在')
                return { value: { ok: ns }, revision: 3 }
              },
            }
          : name === 'pluginManager'
            ? { listBundles: async () => [], listVersionExemptions: async () => ({ runtimeVersion: '0.2.2-rc.3' }) }
            : undefined,
    }
    const { exportSoul } = await import('../lib/soul/export.js')
    // resolveHome 读的是进程环境：不指过去的话，这段会去读真实机器上的 settings.yaml。
    const previous = process.env.DSH_HOME
    process.env.DSH_HOME = home
    let result
    try {
      result = await exportSoul({ ctx, home, profile: 'web', outDir: join(root, 'pack'), runPack: async () => null })
    } finally {
      if (previous === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = previous
    }
    assert.equal(result.ok, true)
    assert.equal(result.configExported, true, '要真的导出配置，而不是一句"读不到"')
    assert.equal(result.settingsNamespaces, 2, '两条能读到的要导出去')
    assert.deepEqual(asked.sort(), ['broken-entry', 'llm-deepseek', 'skin'], '三个名字都要问一遍')
  })
})


test('选包：设置页能浏览目录挑一个，而不是只能手填', async () => {
  const { readFileSync } = await import('node:fs')
  const routes = readFileSync(new URL('../lib/soul/routes.js', import.meta.url), 'utf8')
  assert.match(routes, /'\/mini-remote\/soul\/browse-roots'/, '要有"常用位置"接口')
  assert.match(routes, /'\/mini-remote\/soul\/browse-list'/, '要有列子目录接口')
  assert.match(routes, /listDirectory/, '复用已有的读目录实现')
  // 复用 browse.js 而不是自己写一套：那份已经处理了跨平台盘符与权限边界。
  assert.match(routes, /from '\.\.\/browse\.js'/, '要复用 lib/browse.js')

  const client = readFileSync(new URL('../client/client.js', import.meta.url), 'utf8')
  assert.match(client, /onClick: openPicker/, '要有个"选择…"按钮')
  assert.match(client, /browse-list\?path=/, '要能逐层进目录')
  assert.match(client, /用这个目录/, '要能确认选中')
  assert.match(client, /choosePickerPath/, '选中后要填进输入框')
})
