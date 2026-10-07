/**
 * Resolving the vcpkg tree, binary and triplet, and recording where each answer came from.
 *
 * `VCPKG_ROOT` is a hard dependency of the C++ build in a vcpkg-managed
 * project, and on Windows `vcvars64.bat` silently rewrites it to the tree that
 * ships inside Visual Studio. The two trees can differ, and a version skew
 * makes vcpkg rebuild its whole installed set under a new compiler hash. So
 * resolution here never guesses silently: every candidate is reported with the
 * source that produced it, and a disagreement between the configured tree and
 * the environment is a warning the caller can see.
 *
 * @module dsh-vcpkg/core/environment
 */

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { homedir, arch, platform } from 'node:os'
import { dirname, isAbsolute, join, parse, resolve } from 'node:path'

import { messageOf, runProcess } from './runner.js'

/** Host-triplet table, matching vcpkg's own community triplet names. */
const TRIPLET_BY_PLATFORM = {
  'darwin-arm64': 'arm64-osx',
  'darwin-x64': 'x64-osx',
  'linux-x64': 'x64-linux',
  'linux-arm64': 'arm64-linux',
  'linux-arm': 'arm-linux',
  'win32-x64': 'x64-windows',
  'win32-arm64': 'arm64-windows',
  'win32-ia32': 'x86-windows',
}

/** Directory names never worth descending into while looking for a manifest. */
const MANIFEST_SCAN_SKIP = new Set([
  'node_modules', 'target', 'out', 'dist', 'build', 'Build', '.git', '.cache',
  'vcpkg_installed', 'third_party', 'thirdparty', '.venv', 'venv', '__pycache__',
])

/** Bounds for the downward manifest search: small enough to stay interactive. */
const MANIFEST_SCAN_MAX_DEPTH = 3
const MANIFEST_SCAN_MAX_DIRS = 2000

/** Memoized `vcpkg version` output, keyed by binary path. */
const versionCache = new Map()

/** Cache lifetime for a version probe, in milliseconds. */
const VERSION_CACHE_TTL_MS = 60_000

/**
 * The triplet vcpkg would pick on this host when nothing overrides it.
 * @returns {string | null} the host triplet, or null for an unmapped platform.
 */
export function hostTriplet() {
  return TRIPLET_BY_PLATFORM[`${platform()}-${arch()}`] ?? null
}

/**
 * The vcpkg executable's file name on this platform.
 * @returns {string} `vcpkg.exe` on Windows, `vcpkg` elsewhere.
 */
export function vcpkgBinaryName() {
  return platform() === 'win32' ? 'vcpkg.exe' : 'vcpkg'
}

/**
 * Whether a path names an existing regular file.
 * @param {string} path - the candidate path.
 * @returns {boolean} the answer.
 */
export function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/**
 * Whether a path names an existing directory.
 * @param {string} path - the candidate path.
 * @returns {boolean} the answer.
 */
export function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * The session workspace of the calling agent, when one applies.
 * @param {{ agent?: { session?: { header?: { cwd?: string } } } }} exec - the tool run context.
 * @returns {string | undefined} the session working directory.
 */
export function sessionCwd(exec) {
  const cwd = exec?.agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.length > 0 ? cwd : undefined
}

/**
 * Resolve a model-supplied path against the session workspace.
 * @param {unknown} value - the model-supplied path.
 * @param {{ agent?: object }} exec - the tool run context.
 * @returns {string} an absolute path.
 */
export function resolveUserPath(value, exec) {
  const raw = typeof value === 'string' ? value.trim() : ''
  const base = sessionCwd(exec) ?? process.cwd()
  if (raw.length === 0) return base
  return isAbsolute(raw) ? resolve(raw) : resolve(base, raw)
}

/**
 * The directory one call is anchored at.
 * @param {unknown} explicit - the model-supplied `projectDir`.
 * @param {{ agent?: object }} exec - the tool run context.
 * @returns {string} the absolute anchor directory.
 */
export function resolveProjectDir(explicit, exec) {
  return resolveUserPath(explicit, exec)
}

/**
 * Look for `vcpkg.json` in a directory and, failing that, nearby.
 *
 * A manifest is often one or two levels down (`crates/native/vcpkg.json` in a
 * Cargo workspace that drives CMake), so an upward-only search from a
 * repository root finds nothing. The downward leg is breadth-first and bounded
 * in both depth and directory count so it stays fast on a large tree.
 * @param {object} options - the search.
 * @param {string} options.startDir - the anchor directory.
 * @param {unknown} [options.explicitPath] - a file or directory the caller named.
 * @returns {{ path: string, foundBy: string } | null} the manifest location.
 */
export function findManifestFile({ startDir, explicitPath }) {
  const raw = typeof explicitPath === 'string' ? explicitPath.trim() : ''
  if (raw.length > 0) {
    const named = isAbsolute(raw) ? resolve(raw) : resolve(startDir, raw)
    if (isFile(named)) return { path: named, foundBy: 'the path you named' }
    if (isFile(join(named, 'vcpkg.json'))) return { path: join(named, 'vcpkg.json'), foundBy: 'the directory you named' }
    return null
  }

  for (let dir = startDir; ;) {
    const direct = join(dir, 'vcpkg.json')
    if (isFile(direct)) {
      return { path: direct, foundBy: dir === startDir ? 'the working directory' : `the parent directory ${dir}` }
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  const scanned = scanForManifest(startDir)
  return scanned === null ? null : { path: scanned, foundBy: 'a bounded search below the working directory' }
}

/**
 * Breadth-first, depth- and count-bounded search for a `vcpkg.json`.
 * @param {string} root - the directory to search below.
 * @returns {string | null} the first manifest found.
 */
function scanForManifest(root) {
  /** @type {{ dir: string, depth: number }[]} */
  const queue = [{ dir: root, depth: 0 }]
  let visited = 0
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) break
    if (visited >= MANIFEST_SCAN_MAX_DIRS) return null
    visited += 1
    let entries
    try {
      entries = readdirSync(current.dir, { withFileTypes: true })
    } catch {
      continue
    }
    if (entries.some((entry) => entry.isFile() && entry.name === 'vcpkg.json')) return join(current.dir, 'vcpkg.json')
    if (current.depth >= MANIFEST_SCAN_MAX_DEPTH) continue
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.') || MANIFEST_SCAN_SKIP.has(entry.name) || entry.name.startsWith('cmake-build')) continue
      queue.push({ dir: join(current.dir, entry.name), depth: current.depth + 1 })
    }
  }
  return null
}

/**
 * Candidate vcpkg roots in priority order, each tagged with where it came from.
 * @param {object} options - the inputs.
 * @param {string} options.projectDir - the call's anchor directory.
 * @param {unknown} [options.configRoot] - `vcpkgRoot` from Config.
 * @param {unknown} [options.settingsRoot] - `vcpkgRoot` from the settings file.
 * @param {NodeJS.ProcessEnv} [options.env] - environment to read.
 * @returns {{ path: string, source: string }[]} the ordered candidates.
 */
export function candidateRoots({ projectDir, configRoot, settingsRoot, env = process.env }) {
  const candidates = []
  const push = (value, source) => {
    if (typeof value !== 'string' || value.trim().length === 0) return
    const path = resolve(value.trim())
    if (candidates.some((candidate) => candidate.path === path)) return
    candidates.push({ path, source })
  }

  push(configRoot, 'the plugin Config vcpkgRoot')
  push(settingsRoot, 'the settings file vcpkgRoot')
  push(env.VCPKG_ROOT, 'the VCPKG_ROOT environment variable')
  push(env.VCPKG_INSTALLATION_ROOT, 'the VCPKG_INSTALLATION_ROOT environment variable')

  for (let dir = projectDir; ;) {
    if (isFile(join(dir, '.vcpkg-root'))) {
      push(dir, `the .vcpkg-root marker in ${dir}`)
      break
    }
    const parent = dirname(dir)
    if (parent === dir || dir === parse(dir).root) break
    dir = parent
  }

  const home = homedir()
  if (platform() === 'win32') {
    push('C:\\vcpkg', 'a conventional install location')
    push('C:\\dev\\vcpkg', 'a conventional install location')
    push('C:\\src\\vcpkg', 'a conventional install location')
    push(join(home, 'vcpkg'), 'a conventional install location')
    if (typeof env.LOCALAPPDATA === 'string') push(join(env.LOCALAPPDATA, 'vcpkg'), 'a conventional install location')
  } else {
    push(join(home, 'vcpkg'), 'a conventional install location')
    push('/usr/local/share/vcpkg', 'a conventional install location')
    push('/opt/vcpkg', 'a conventional install location')
  }
  return candidates
}

/**
 * Inspect one candidate root without running anything.
 * @param {{ path: string, source: string }} candidate - the candidate.
 * @returns {object} the inspection, including the two files vcpkg itself needs.
 */
export function inspectRoot(candidate) {
  const binary = join(candidate.path, vcpkgBinaryName())
  const toolchainFile = join(candidate.path, 'scripts', 'buildsystems', 'vcpkg.cmake')
  const hasBinary = isFile(binary)
  const hasToolchain = isFile(toolchainFile)
  return {
    path: candidate.path,
    source: candidate.source,
    exists: existsSync(candidate.path),
    binary,
    hasBinary,
    toolchainFile,
    hasToolchain,
    usable: hasBinary,
    note: hasBinary
      ? (hasToolchain ? 'bootstrapped' : 'has the vcpkg binary but no scripts/buildsystems/vcpkg.cmake')
      : (isDirectory(candidate.path) ? 'directory exists but vcpkg is not bootstrapped here' : 'path does not exist'),
  }
}

/**
 * Read the commit the vcpkg tree's own checkout is at, without running git.
 * vcpkg's `builtin-baseline` must be reachable from this checkout, so a skew
 * between the baseline and this commit is the root cause of a whole class of
 * `vcpkg install` failures.
 * @param {string} root - the vcpkg root.
 * @returns {string | null} the 40-hex commit, or null when it cannot be read.
 */
export function readTreeHead(root) {
  const dotGit = join(root, '.git')
  let gitDir = dotGit
  try {
    if (!statSync(dotGit).isDirectory()) {
      const match = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, 'utf8'))
      if (match === null) return null
      gitDir = resolve(root, match[1].trim())
    }
  } catch {
    return null
  }
  try {
    const head = readFileSync(join(gitDir, 'HEAD'), 'utf8').trim()
    if (/^[0-9a-f]{40}$/.test(head)) return head
    const ref = /^ref:\s*(.+)$/.exec(head)?.[1]?.trim()
    if (ref === undefined) return null
    try {
      return readFileSync(join(gitDir, ref), 'utf8').trim()
    } catch {
      const packed = readFileSync(join(gitDir, 'packed-refs'), 'utf8')
      const line = packed.split('\n').find((entry) => entry.endsWith(` ${ref}`))
      return line === undefined ? null : line.split(' ')[0]
    }
  } catch {
    return null
  }
}

/**
 * Whether a vcpkg checkout can reach one commit.
 *
 * A manifest's `builtin-baseline` must exist inside the registry checkout, so
 * a tree that is behind its baseline fails `vcpkg install` with an error that
 * names the commit but not the cause. This answers that question directly.
 * @param {object} options - the check.
 * @param {string} options.root - the vcpkg checkout.
 * @param {string} options.commit - the baseline commit to look for.
 * @param {AbortSignal} [options.signal] - caller cancellation.
 * @returns {Promise<boolean | null>} the answer, or null when git cannot say.
 */
export async function isCommitReachable({ root, commit, signal }) {
  if (!existsSync(join(root, '.git'))) return null
  const result = await runProcess({
    command: 'git',
    args: ['-C', root, 'cat-file', '-e', `${commit}^{commit}`],
    signal,
    timeoutMs: 20_000,
    maxOutputBytes: 4 * 1024,
  })
  if (result.spawnError !== null) return null
  if (result.code === 0) return true
  // 128 covers both "unknown revision" and a broken repository.
  return false
}

/**
 * Run `vcpkg version`, memoized for a minute.
 * @param {string} binary - the vcpkg executable.
 * @param {AbortSignal} [signal] - caller cancellation.
 * @returns {Promise<object>} the parsed version, or the failure to report.
 */
export async function readVcpkgVersion(binary, signal) {
  const cached = versionCache.get(binary)
  if (cached !== undefined && Date.now() - cached.at < VERSION_CACHE_TTL_MS) return cached.value

  const result = await runProcess({ command: binary, args: ['version'], signal, timeoutMs: 30_000, maxOutputBytes: 16 * 1024 })
  let value
  if (result.spawnError !== null) {
    value = { raw: null, version: null, commit: null, error: result.spawnError }
  } else {
    const match = /^vcpkg package management program version (.+)$/m.exec(result.stdout)
    if (match === null) {
      const detail = (result.stderr.trim() || result.stdout.trim() || `exit code ${result.code}`).split('\n').slice(0, 3).join(' ').slice(0, 500)
      value = { raw: null, version: null, commit: null, error: detail }
    } else {
      const raw = match[1].trim()
      const parts = /^(?<date>\d{4}-\d{2}-\d{2})-(?<commit>[0-9a-fA-F]{7,40})$/.exec(raw)
      value = { raw, version: parts?.groups?.date ?? raw, commit: parts?.groups?.commit?.toLowerCase() ?? null, error: null }
    }
  }
  versionCache.set(binary, { at: Date.now(), value })
  return value
}

/**
 * Resolve the triplet for one call and say where it came from.
 * @param {object} options - the inputs.
 * @param {unknown} [options.explicit] - the model-supplied `triplet`.
 * @param {object} [options.config] - the plugin Config.
 * @param {Record<string, unknown>} [options.settings] - the settings file values.
 * @param {NodeJS.ProcessEnv} [options.env] - environment to read.
 * @returns {{ triplet: string | null, source: string }} the resolution.
 */
export function resolveTriplet({ explicit, config = {}, settings = {}, env = process.env }) {
  if (typeof explicit === 'string' && explicit.trim().length > 0) {
    return { triplet: explicit.trim(), source: 'the `triplet` argument' }
  }
  const fromEnv = env.VCPKG_DEFAULT_TRIPLET
  if (typeof fromEnv === 'string' && fromEnv.trim().length > 0) {
    return { triplet: fromEnv.trim(), source: 'the VCPKG_DEFAULT_TRIPLET environment variable' }
  }
  for (const [value, source] of [
    [settings.triplet, 'the settings file triplet'],
    [config.triplet, 'the plugin Config triplet'],
  ]) {
    if (typeof value === 'string' && value.trim().length > 0) return { triplet: value.trim(), source }
  }
  const host = hostTriplet()
  if (host !== null) return { triplet: host, source: 'the host platform default' }
  return { triplet: null, source: 'unresolved: this platform has no default triplet, pass `triplet` explicitly' }
}

/**
 * Resolve everything one vcpkg invocation needs to know about the tree.
 * @param {object} options - the inputs.
 * @param {string} options.projectDir - the call's anchor directory.
 * @param {object} [options.config] - the plugin Config.
 * @param {Record<string, unknown>} [options.settings] - the settings file values.
 * @param {NodeJS.ProcessEnv} [options.env] - environment to read.
 * @param {AbortSignal} [options.signal] - caller cancellation.
 * @param {unknown} [options.triplet] - an explicit triplet argument.
 * @returns {Promise<object>} the environment report.
 */
export async function resolveEnvironment({ projectDir, config = {}, settings = {}, env = process.env, signal, triplet }) {
  const candidates = candidateRoots({ projectDir, configRoot: config.vcpkgRoot, settingsRoot: settings.vcpkgRoot, env })
  const inspected = candidates.map(inspectRoot)
  const chosen = inspected.find((candidate) => candidate.usable) ?? null
  const warnings = []

  const envRoot = typeof env.VCPKG_ROOT === 'string' && env.VCPKG_ROOT.trim().length > 0 ? resolve(env.VCPKG_ROOT.trim()) : null
  if (envRoot !== null && chosen !== null && chosen.path !== envRoot) {
    warnings.push(
      `VCPKG_ROOT points at ${envRoot}, but this call resolved ${chosen.path} (${chosen.source}). `
      + 'The C++ build reads VCPKG_ROOT directly, so a build may use a different tree than these tools report. '
      + 'On Windows, `vcvars64.bat` rewrites VCPKG_ROOT to the tree inside Visual Studio as soon as it runs.',
    )
  }
  if (envRoot !== null && !existsSync(envRoot)) {
    warnings.push(`VCPKG_ROOT points at ${envRoot}, which does not exist; the C++ build fails on that alone.`)
  }
  if (chosen === null) {
    warnings.push('no bootstrapped vcpkg tree found; run `bootstrap-vcpkg.sh` (or `bootstrap-vcpkg.bat`) in the tree you intend to use.')
  } else if (!chosen.hasToolchain) {
    warnings.push(`${chosen.path} has no scripts/buildsystems/vcpkg.cmake; the CMake toolchain file cannot be used from this tree.`)
  }

  const version = chosen === null ? null : await readVcpkgVersion(chosen.binary, signal)
  const treeHead = chosen === null ? null : readTreeHead(chosen.path)
  const resolvedTriplet = resolveTriplet({ explicit: triplet, config, settings, env })

  return {
    projectDir,
    root: chosen?.path ?? null,
    rootSource: chosen?.source ?? null,
    binary: chosen?.binary ?? null,
    toolchainFile: chosen?.toolchainFile ?? null,
    hasToolchain: chosen?.hasToolchain ?? false,
    version,
    treeHead,
    triplet: resolvedTriplet.triplet,
    tripletSource: resolvedTriplet.source,
    candidates: inspected,
    envVcpkgRoot: envRoot,
    warnings,
  }
}

/**
 * Render an environment report as model-facing text.
 * @param {object} environment - a {@link resolveEnvironment} report.
 * @returns {string} the rendered report.
 */
export function renderEnvironment(environment) {
  const lines = []
  if (environment.root === null) {
    lines.push('vcpkg root: NOT FOUND')
  } else {
    lines.push(`vcpkg root: ${environment.root}`)
    lines.push(`  source: ${environment.rootSource}`)
    lines.push(`  binary: ${environment.binary}`)
    lines.push(`  version: ${environment.version?.raw ?? `unavailable (${environment.version?.error ?? 'unknown error'})`}`)
    lines.push(`  toolchain file: ${environment.hasToolchain ? environment.toolchainFile : 'MISSING (scripts/buildsystems/vcpkg.cmake)'}`)
    if (environment.treeHead !== null) lines.push(`  checkout HEAD: ${environment.treeHead}`)
  }
  lines.push(`triplet: ${environment.triplet ?? '<unresolved>'} (from ${environment.tripletSource})`)
  for (const warning of environment.warnings) lines.push(`warning: ${warning}`)
  return lines.join('\n')
}

/**
 * One line naming the tree and version, for a tool result header.
 * @param {object} environment - a {@link resolveEnvironment} report.
 * @returns {string} the summary.
 */
export function describeEnvironment(environment) {
  if (environment.root === null) return 'vcpkg: not found'
  return `vcpkg: ${environment.version?.version ?? 'unknown version'} at ${environment.root} (triplet ${environment.triplet ?? '?'})`
}

/**
 * Render an unknown thrown value as one line.
 * @param {unknown} error - the thrown value.
 * @returns {string} the message.
 */
export function errorText(error) {
  return messageOf(error)
}
