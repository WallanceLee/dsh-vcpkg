/**
 * dsh-vcpkg smoke tests.
 *
 * Two layers, because they have different prerequisites:
 *
 *   1. Core assertions import only `node:*` modules, so they run anywhere —
 *      including inside a checkout with no peer dependencies installed. This is
 *      where the parsing, resolution, and reconciliation logic is pinned.
 *   2. Tool assertions need `@deepseek-ai/dsh-tools`, so they run only once the
 *      plugin sits somewhere Node can resolve its peers from (an installed
 *      profile, or a dev tree with the peers linked). They are skipped with a
 *      printed reason otherwise, never silently.
 *
 * Run: node --test tests/
 *
 * @module dsh-vcpkg/tests/smoke
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  candidateRoots,
  findManifestFile,
  hostTriplet,
  inspectRoot,
  resolveEnvironment,
  resolveTriplet,
} from '../lib/core/environment.js'
import { normalizeManifest, reconcile, stripJsonComments } from '../lib/core/manifest.js'
import { parseSearchOutput } from '../lib/core/registry.js'
import {
  buildNoProxy,
  buildProxyCandidates,
  looksLikeNetworkFailure,
  parseProxyUrl,
  probeTcp,
  proxyEnvFor,
} from '../lib/core/proxy.js'
import { runProcess, truncateToBytes } from '../lib/core/runner.js'
import { candidateInstallRoots, parseStatusDb, selectInstallRoot } from '../lib/core/status-db.js'
import { settingsPath } from '../lib/core/settings.js'
import { startJobProcess } from '../lib/core/stream.js'

/**
 * Synthetic vcpkg-managed workspace, checked in so the suite is reproducible on
 * any machine. It carries a nested manifest and a populated installed-package
 * database, including one deliberately absent port and one missing feature.
 */
const FIXTURE = join(import.meta.dirname, 'fixtures', 'workspace')

/**
 * A real vcpkg tree on this machine, when one exists. Tests that need to run
 * the vcpkg binary skip without it rather than failing.
 */
const REAL_VCPKG_ROOT = candidateRoots({ projectDir: FIXTURE, env: process.env })
  .map(inspectRoot)
  .find((candidate) => candidate.usable)?.path ?? null

/**
 * Create a directory that looks like a bootstrapped vcpkg tree. Only the two
 * files `inspectRoot` probes are written; nothing in it is ever executed. This
 * lets the registration-path tests run on a machine with no vcpkg at all.
 * @returns {Promise<string>} the tree root, for the caller to remove.
 */
async function makeFakeVcpkgTree() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-vcpkg-tree-'))
  await mkdir(join(root, 'scripts', 'buildsystems'), { recursive: true })
  await writeFile(join(root, 'vcpkg'), '', { mode: 0o755 })
  await writeFile(join(root, 'scripts', 'buildsystems', 'vcpkg.cmake'), '')
  return root
}

test('truncateToBytes never emits a split code point', () => {
  const text = 'a'.repeat(10) + '中文'.repeat(4)
  const cut = truncateToBytes(text, 13)
  assert.ok(Buffer.byteLength(cut, 'utf8') <= 13)
  assert.ok(!cut.includes('\uFFFD') || cut.endsWith('\uFFFD'), 'only the final code point may be replaced')
  assert.equal(truncateToBytes('short', 100), 'short')
})

test('parseStatusDb merges feature records into their base package', () => {
  // vcpkg writes one base record per port plus one record per enabled feature,
  // all sharing `Package:`. Reporting them as separate packages would be wrong.
  const text = [
    'Package: gdal',
    'Version: 3.12.4',
    'Port-Version: 2',
    'Depends: json-c, proj, zlib',
    'Architecture: arm64-osx',
    'Multi-Arch: same',
    'Abi: eb544653391fd2b3abcf39db731f6c630b56ec29c82934ca6c39db71deff000a',
    'Description: The Geographic Data Abstraction Library for reading and writing geospatial raster and vector data',
    'Default-Features: gif, iconv, netcdf',
    'Status: install ok installed',
    '',
    'Package: gdal',
    'Feature: iconv',
    'Depends: libiconv',
    'Description: Use iconv library',
    'Status: install ok installed',
    '',
    'Package: removed-port',
    'Version: 1.0.0',
    'Status: purge ok not-installed',
    '',
    'Package: basisu',
    'Version: 2.50',
    'Status: install ok installed',
    '',
  ].join('\n')
  const packages = parseStatusDb(text)
  assert.deepEqual(packages.map((entry) => entry.name), ['basisu', 'gdal'])
  const gdal = packages.find((entry) => entry.name === 'gdal')
  assert.equal(gdal.version, '3.12.4#2', 'the port version renders the way vcpkg list renders it')
  assert.equal(gdal.baseVersion, '3.12.4')
  assert.equal(gdal.portVersion, 2)
  assert.deepEqual(gdal.features, ['iconv'])
  assert.equal(gdal.featureDescriptions.iconv, 'Use iconv library')
  assert.deepEqual(gdal.defaultFeatures, ['gif', 'iconv', 'netcdf'])
  assert.deepEqual(gdal.depends, ['json-c', 'proj', 'zlib'])
  assert.match(gdal.abi, /^eb544653/)
})

test('stripJsonComments keeps comment markers inside strings', () => {
  const input = '{\n  // a comment\n  "url": "https://example.com//x",\n  /* block */\n  "n": 1\n}'
  const parsed = JSON.parse(stripJsonComments(input))
  assert.equal(parsed.url, 'https://example.com//x')
  assert.equal(parsed.n, 1)
})

test('reconcile reports missing ports and missing features separately', () => {
  const manifest = normalizeManifest({
    name: 'demo',
    'version-string': '1.0.0',
    'builtin-baseline': 'a'.repeat(40),
    dependencies: ['fmt', { name: 'gdal', 'default-features': false, features: ['iconv'] }, 'absent-port'],
  }, '/tmp/vcpkg.json')
  assert.equal(manifest.dependencies.length, 3)
  assert.equal(manifest.dependencies[1].defaultFeatures, false)

  const installed = [
    { name: 'fmt', version: '10.2.1', features: [] },
    { name: 'gdal', version: '3.9.0', features: ['netcdf'] },
  ]
  const reconciliation = reconcile(manifest, installed)
  assert.deepEqual(reconciliation.satisfied.map((entry) => entry.name), ['fmt'])
  assert.deepEqual(reconciliation.missing.map((entry) => entry.name), ['absent-port'])
  assert.equal(reconciliation.missingFeatures.length, 1)
  assert.deepEqual(reconciliation.missingFeatures[0].missingFeatures, ['iconv'])
  assert.equal(reconciliation.complete, false)
})

test('parseSearchOutput separates ports from port features', () => {
  const output = [
    'assimp[draco]                             Enable Draco compressed mesh support',
    'draco                    1.5.7#1          A library for compressing and decompressing 3D geometric meshes and point ...',
    'pdal[draco]                               Build the Draco plugin',
    'The result may be outdated. Run `git pull` to get the latest results.',
  ].join('\n')
  const parsed = parseSearchOutput(output)
  assert.deepEqual(parsed.ports, [{
    name: 'draco',
    version: '1.5.7#1',
    description: 'A library for compressing and decompressing 3D geometric meshes and point ...',
  }])
  assert.deepEqual(parsed.features.map((entry) => `${entry.port}[${entry.feature}]`), ['assimp[draco]', 'pdal[draco]'])
})

test('parseProxyUrl accepts the forms a user actually types', () => {
  assert.equal(parseProxyUrl('127.0.0.1:7890').url, 'http://127.0.0.1:7890')
  assert.equal(parseProxyUrl('http://127.0.0.1:7890/').url, 'http://127.0.0.1:7890')
  assert.equal(parseProxyUrl('socks5://127.0.0.1:1080').protocol, 'socks5')
  assert.equal(parseProxyUrl('https://proxy.corp.example:8443').port, 8443)
  assert.equal(parseProxyUrl(''), null)
  assert.equal(parseProxyUrl(undefined), null)
  assert.equal(parseProxyUrl('not a url'), null)
  assert.equal(parseProxyUrl('ftp://127.0.0.1:21'), null)
})

test('buildNoProxy always keeps loopback direct and dedupes', () => {
  const value = buildNoProxy('example.com, LOCALHOST ,example.com')
  assert.deepEqual(value.split(','), ['example.com', 'LOCALHOST', '127.0.0.1', '::1'])
})

test('proxyEnvFor sets both letter cases without mutating the base environment', () => {
  const base = { PATH: '/usr/bin', HTTPS_PROXY: 'http://old:1' }
  const env = proxyEnvFor({ url: 'http://127.0.0.1:7890', noProxy: 'localhost,127.0.0.1' }, base)
  assert.equal(base.HTTPS_PROXY, 'http://old:1', 'the caller environment must not be mutated')
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:7890')
  assert.equal(env.https_proxy, 'http://127.0.0.1:7890')
  assert.equal(env.NO_PROXY, 'localhost,127.0.0.1')
  const direct = proxyEnvFor({ url: null, noProxy: 'localhost' }, base)
  assert.equal(direct.HTTPS_PROXY, 'http://old:1', 'a null resolution leaves an existing value alone')
})

test('looksLikeNetworkFailure matches real vcpkg failure text and not build errors', () => {
  assert.ok(looksLikeNetworkFailure('curl: (7) Failed to connect to github.com port 443 after 0 ms'))
  assert.ok(looksLikeNetworkFailure('error: Failed to download from https://github.com/microsoft/vcpkg/...'))
  assert.ok(looksLikeNetworkFailure('fatal: unable to access ... Could not resolve host: github.com'))
  assert.ok(!looksLikeNetworkFailure("error: building package fmt failed with: BUILD_FAILED"))
})

test('buildProxyCandidates dedupes and honours configured entries first', () => {
  const candidates = buildProxyCandidates(['127.0.0.1:7890', 'http://127.0.0.1:7890'])
  assert.equal(candidates[0].url, 'http://127.0.0.1:7890')
  assert.equal(candidates.filter((entry) => entry.url === 'http://127.0.0.1:7890').length, 1)
  assert.ok(candidates.length > 5)
})

test('probeTcp reports a closed port as unreachable', async () => {
  // Port 1 is reserved and never accepts connections in practice.
  assert.equal(await probeTcp({ host: '127.0.0.1', port: 1, timeoutMs: 300 }), false)
})

test('runProcess captures output, exit codes, and cancellation', async () => {
  const ok = await runProcess({ command: process.execPath, args: ['-e', 'console.log("out"); console.error("err")'] })
  assert.equal(ok.code, 0)
  assert.equal(ok.stdout.trim(), 'out')
  assert.equal(ok.stderr.trim(), 'err')
  assert.equal(ok.failed, false)

  const bad = await runProcess({ command: process.execPath, args: ['-e', 'process.exit(3)'] })
  assert.equal(bad.code, 3)
  assert.equal(bad.failed, true)

  const missing = await runProcess({ command: '/nonexistent/vcpkg-binary', args: [] })
  assert.ok(missing.spawnError !== null)
  assert.equal(missing.failed, true)

  const controller = new AbortController()
  const slow = runProcess({ command: process.execPath, args: ['-e', 'setTimeout(() => {}, 30000)'], signal: controller.signal })
  setTimeout(() => controller.abort(), 150)
  const aborted = await slow
  assert.equal(aborted.aborted, true)
})

test('startJobProcess streams to the job and settles without duplicating output', async () => {
  const appended = []
  // Progress is throttled, so a process this short may legitimately emit none.
  const progress = []
  const job = startJobProcess({
    command: process.execPath,
    args: ['-e', 'console.log("phase one"); console.error("a warning"); console.log("done")'],
    append: (text) => appended.push(text),
    progress: (line) => progress.push(line),
  })
  assert.deepEqual(Object.keys(job).sort(), ['cancel', 'done', 'pid'])
  assert.ok(Array.isArray(progress))

  const outcome = await job.done
  // JobOutcome carries settlement facts only. Filling `result` with the same
  // bytes that went through `append` makes job_output render the log twice,
  // which is the defect this assertion exists to prevent.
  assert.ok(Object.keys(outcome).every((key) => ['status', 'detail', 'result'].includes(key)),
    `unexpected JobOutcome keys ${JSON.stringify(Object.keys(outcome))}`)
  assert.equal(outcome.result, undefined, 'the outcome must not duplicate the ring contents')
  assert.equal(outcome.status, 'completed')
  assert.match(outcome.detail, /exit code: 0/)

  const streamed = appended.join('')
  assert.match(streamed, /phase one/)
  assert.match(streamed, /\[stderr\] a warning/, 'stderr is tagged so a reader can tell the streams apart')
  assert.match(streamed, /done/)
})

test('startJobProcess reports a non-zero exit as failed and a cancel as killed', async () => {
  const failing = startJobProcess({
    command: process.execPath,
    args: ['-e', 'console.error("boom"); process.exit(3)'],
    append: () => {},
  })
  const failed = await failing.done
  assert.equal(failed.status, 'failed')
  assert.match(failed.detail, /exit code: 3/)

  const slow = startJobProcess({
    command: process.execPath,
    args: ['-e', 'setTimeout(() => {}, 30000)'],
    append: () => {},
  })
  slow.cancel('test teardown')
  const killed = await slow.done
  assert.equal(killed.status, 'killed')
  assert.match(killed.detail, /cancelled/)
})

test('findManifestFile locates a manifest nested below a workspace root', () => {
  const found = findManifestFile({ startDir: FIXTURE })
  assert.ok(found !== null, `expected a vcpkg.json below ${FIXTURE}`)
  assert.equal(found.path, join(FIXTURE, 'crates', 'native', 'vcpkg.json'))
  assert.equal(found.foundBy, 'a bounded search below the working directory')
})

test('findManifestFile prefers a directory the caller names', () => {
  const found = findManifestFile({ startDir: FIXTURE, explicitPath: join('crates', 'native') })
  assert.ok(found !== null)
  assert.equal(found.foundBy, 'the directory you named')
})

test('candidateRoots puts explicit configuration ahead of the environment', () => {
  const roots = candidateRoots({
    projectDir: FIXTURE,
    configRoot: '/tmp/pinned-vcpkg',
    env: { VCPKG_ROOT: '/tmp/env-vcpkg' },
  })
  assert.equal(roots[0].path, '/tmp/pinned-vcpkg')
  assert.match(roots[0].source, /Config/)
  assert.equal(roots[1].path, '/tmp/env-vcpkg')
})

test('inspectRoot distinguishes a bootstrapped tree from an empty directory', () => {
  const inspected = inspectRoot({ path: '/tmp', source: 'test' })
  assert.equal(inspected.usable, false)
  assert.equal(inspected.exists, true)
  assert.match(inspected.note, /not bootstrapped/)
})

test('resolveTriplet reports where the answer came from', () => {
  assert.deepEqual(resolveTriplet({ explicit: 'x64-windows', env: {} }), {
    triplet: 'x64-windows',
    source: 'the `triplet` argument',
  })
  assert.equal(resolveTriplet({ env: { VCPKG_DEFAULT_TRIPLET: 'arm64-osx' } }).triplet, 'arm64-osx')
  assert.equal(resolveTriplet({ env: {} }).triplet, hostTriplet())
})

test('resolveEnvironment reports a usable tree when this machine has one', {
  skip: REAL_VCPKG_ROOT === null ? 'no bootstrapped vcpkg tree on this machine' : false,
}, async () => {
  const environment = await resolveEnvironment({ projectDir: FIXTURE, env: process.env })
  assert.equal(environment.root, REAL_VCPKG_ROOT)
  assert.equal(environment.binary, join(REAL_VCPKG_ROOT, 'vcpkg'))
  assert.ok(environment.version !== null)
  assert.ok(environment.triplet !== null)
  assert.ok(environment.candidates.length > 0)
})

test('resolveEnvironment refuses to invent a tree when none exists', async () => {
  const environment = await resolveEnvironment({
    projectDir: FIXTURE,
    env: { VCPKG_ROOT: '/nonexistent/vcpkg-tree' },
  })
  assert.equal(environment.root, null)
  assert.ok(environment.warnings.some((warning) => warning.includes('/nonexistent/vcpkg-tree')))
})

test('selectInstallRoot picks the fixture install root', async () => {
  const found = findManifestFile({ startDir: FIXTURE })
  assert.ok(found !== null)
  const manifestRoot = found.path.slice(0, found.path.length - 'vcpkg.json'.length)
  const selected = await selectInstallRoot({
    candidates: candidateInstallRoots({ projectDir: FIXTURE, manifestRoot }),
  })
  assert.equal(selected.installRoot, join(FIXTURE, 'build', 'cmake_build', 'vcpkg_installed'))
  assert.equal(selected.checked.find((entry) => entry.path === selected.installRoot).hasDatabase, true)
})

test('the settings file lives under the Harness home', () => {
  assert.equal(settingsPath({ DSH_HOME: '/tmp/dsh-home' }), '/tmp/dsh-home/vcpkg.json')
})

test('tools register and execute when the peer dependencies resolve', async (t) => {
  let dshTools
  try {
    dshTools = await import('@deepseek-ai/dsh-tools')
  } catch (error) {
    t.skip(`@deepseek-ai/dsh-tools is not resolvable from ${import.meta.dirname}: ${error.code ?? error.message}`)
    return
  }
  assert.equal(typeof dshTools.defineTool, 'function')

  const plugin = await import('../lib/index.js')
  assert.equal(plugin.name, 'dsh-vcpkg')
  assert.deepEqual(plugin.inject, ['tools'])
  assert.equal(typeof plugin.apply, 'function')

  const registered = []
  const ctx = {
    tools: { register: (definition) => { registered.push(definition); return () => {} } },
    get: () => undefined,
  }
  plugin.apply(ctx, {})
  assert.deepEqual(
    registered.map((definition) => definition.name).sort(),
    ['vcpkg_info', 'vcpkg_install', 'vcpkg_list', 'vcpkg_manifest', 'vcpkg_proxy', 'vcpkg_search'],
  )
  for (const definition of registered) {
    assert.equal(typeof definition.description, 'string')
    assert.ok(definition.description.length > 40, `${definition.name} needs a real description`)
    assert.equal(definition.parameters.type, 'object')
    assert.ok(definition.output.schema !== undefined)
    assert.equal(typeof definition.execute, 'function')
    assert.equal(typeof definition.output.render, 'function')
  }
  assert.deepEqual(Object.keys(registered.find((d) => d.name === 'vcpkg_install').parameters.properties).sort(),
    ['dryRun', 'installRoot', 'manifestRoot', 'runInBackground', 'triplet'])

  const exec = {
    signal: new AbortController().signal,
    agent: { id: 'session-test', session: { header: { cwd: FIXTURE } } },
  }
  const byName = new Map(registered.map((definition) => [definition.name, definition]))

  for (const [name, args] of [
    ['vcpkg_info', {}],
    ['vcpkg_manifest', {}],
    ['vcpkg_list', {}],
    ['vcpkg_proxy', { action: 'status' }],
  ]) {
    const definition = byName.get(name)
    const value = await definition.execute(args, exec)
    // The registry materializes the canonical value as lossless JSON.
    const roundTripped = JSON.parse(JSON.stringify(value))
    assert.deepEqual(roundTripped, value, `${name} must return lossless JSON`)
    const content = definition.output.render(args, value)
    assert.ok(Array.isArray(content) && content.length > 0)
    assert.equal(content[0].type, 'text')
    assert.ok(content[0].text.length > 0, `${name} rendered empty text`)
  }

  const info = await byName.get('vcpkg_info').execute({}, exec)
  assert.equal(info.triplet, hostTriplet())
  assert.equal(info.manifest.path, join(FIXTURE, 'crates', 'native', 'vcpkg.json'))
  assert.equal(info.manifest.name, 'fixture-project')
  assert.equal(typeof info.proxy.url === 'string' || info.proxy.url === null, true)

  const manifest = await byName.get('vcpkg_manifest').execute({}, exec)
  assert.equal(manifest.manifest.name, 'fixture-project')
  assert.equal(manifest.manifest.dependencies.length, 3)
  assert.equal(manifest.installRoot, join(FIXTURE, 'build', 'cmake_build', 'vcpkg_installed'))
  // The fixture is built to exercise all three reconciliation outcomes at once.
  assert.deepEqual(manifest.reconciliation.satisfied.map((entry) => entry.name), ['fmt'])
  assert.deepEqual(manifest.reconciliation.missing.map((entry) => entry.name), ['not-installed-port'])
  assert.deepEqual(manifest.reconciliation.missingFeatures.map((entry) => entry.name), ['gdal'])
  assert.deepEqual(manifest.reconciliation.missingFeatures[0].missingFeatures, ['iconv'])
  assert.equal(manifest.reconciliation.installedTotal, 3, 'a purged record is not an installed package')
  assert.equal(manifest.reconciliation.complete, false)

  const listed = await byName.get('vcpkg_list').execute({ verbose: true }, exec)
  assert.deepEqual(listed.packages.map((entry) => entry.name), ['fmt', 'gdal', 'zlib'])
  const gdal = listed.packages.find((entry) => entry.name === 'gdal')
  assert.equal(gdal.version, '3.12.4#2', 'feature records merge into their base package')
  assert.deepEqual(gdal.features, ['netcdf'])
  assert.deepEqual(gdal.defaultFeatures, ['gif', 'iconv', 'netcdf'])
  assert.equal(gdal.featureDescriptions.netcdf, 'Supported netCDF read/write.')

  // A dry run's product IS its plan, so the plan must survive into the render
  // rather than being hidden behind a success check.
  const planText = byName.get('vcpkg_install').output.render({ dryRun: true }, {
    mode: 'foreground',
    commandLine: 'vcpkg install --triplet=x64-linux --dry-run',
    manifestRoot: '/repo/crates/native',
    installRoot: '/repo/crates/native/vcpkg_installed',
    triplet: 'x64-linux',
    dryRun: true,
    exitCode: 0,
    durationMs: 3700,
    truncated: false,
    timedOut: false,
    stdoutHead: 'Compiler found: /usr/bin/c++\nThe following packages will be built and installed:\n    draco:x64-linux@1.5.7#1',
    stdoutTail: 'Additional packages (*) will be modified to complete this operation.',
    stderrTail: '',
    proxy: { url: 'http://127.0.0.1:7897', source: 'auto-detect' },
    networkSuspected: false,
    warnings: [],
  })[0].text
  assert.match(planText, /dry run of vcpkg install succeeded/)
  assert.match(planText, /The following packages will be built and installed:/)
  assert.match(planText, /draco:x64-linux@1\.5\.7#1/)
  assert.match(planText, /http:\/\/127\.0\.0\.1:7897/)
})

test('the background install registers a 0.2.0 JobSpec', async (t) => {
  let dshTools
  try {
    dshTools = await import('@deepseek-ai/dsh-tools')
  } catch (error) {
    t.skip(`@deepseek-ai/dsh-tools is not resolvable from ${import.meta.dirname}: ${error.code ?? error.message}`)
    return
  }
  assert.equal(typeof dshTools.defineTool, 'function')

  const plugin = await import('../lib/index.js')
  // A stand-in tree keeps this test independent of whether vcpkg is installed.
  const fakeRoot = await makeFakeVcpkgTree()
  t.after(() => rm(fakeRoot, { recursive: true, force: true }))
  /** @type {object[]} */
  const specs = []
  const ctx = {
    tools: { register: () => () => {} },
    // The registry seam is the only thing faked here; everything downstream is real.
    get: (name) => (name === 'jobs'
      ? { start: (spec) => { specs.push(spec); return 'vcpkg-1' } }
      : undefined),
  }
  plugin.apply(ctx, { vcpkgRoot: fakeRoot })

  const registered = []
  const recordingCtx = {
    tools: { register: (d) => { registered.push(d); return () => {} } },
    get: ctx.get,
  }
  plugin.apply(recordingCtx, { vcpkgRoot: fakeRoot })
  const install = registered.find((d) => d.name === 'vcpkg_install')

  const exec = {
    signal: new AbortController().signal,
    agent: { id: 'session-test', session: { header: { cwd: FIXTURE } } },
  }
  const value = await install.execute({ manifestRoot: 'crates/native', dryRun: true, runInBackground: true }, exec)
  assert.equal(value.mode, 'background')
  assert.equal(value.jobId, 'vcpkg-1')
  assert.equal(specs.length, 1)

  // JobSpec (0.2.0): kind, label, optional owner/outputLimitBytes/output, and run.
  const spec = specs[0]
  for (const key of Object.keys(spec)) {
    assert.ok(['kind', 'label', 'owner', 'outputLimitBytes', 'output', 'run'].includes(key),
      `unexpected JobSpec key ${JSON.stringify(key)}`)
  }
  assert.equal(spec.kind, 'vcpkg')
  assert.ok(spec.label.includes('vcpkg install'))
  // The owner is a session id the registry resolves to a live agent, not the agent object.
  assert.equal(spec.owner, 'session-test')
})
