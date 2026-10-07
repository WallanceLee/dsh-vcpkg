/**
 * Proxy resolution for vcpkg's network operations.
 *
 * vcpkg downloads through libcurl and clones registries through git. Both read
 * the same variables (`http_proxy` / `https_proxy` / `all_proxy` / `no_proxy`;
 * git adds its own `http.proxy` config). On a network where the vcpkg registry
 * is only reachable through a local proxy, an unset variable surfaces as an
 * opaque `curl: (7) Failed to connect to github.com port 443` thousands of
 * lines into a build.
 *
 * So every vcpkg invocation this plugin starts resolves ONE effective proxy
 * first and injects it into that child's environment. The host process
 * environment is never mutated: resolution is per-invocation and reversible.
 *
 * Resolution order, first hit wins:
 *   1. `proxy` in `<dshHome>/vcpkg.json` — pinned through `vcpkg_proxy set`
 *   2. the plugin Config `proxy` — pinned through a profile's `cordis.patch.yml`
 *   3. `HTTPS_PROXY` / `https_proxy` / `ALL_PROXY` / `all_proxy`
 *   4. `git config --global --get http.proxy`
 *   5. a TCP probe of well-known local proxy ports (Clash, V2Ray, Surge, …)
 *
 * @module dsh-vcpkg/core/proxy
 */

import { connect } from 'node:net'

import { messageOf, runProcess } from './runner.js'

/** Cache lifetime for a full resolution, in milliseconds. */
export const PROXY_CACHE_TTL_MS = 60_000

/** Timeout for one candidate port probe, in milliseconds. */
export const PROBE_TIMEOUT_MS = 400

/** Hosts that must never go through a proxy, appended to any caller list. */
export const DEFAULT_NO_PROXY = 'localhost,127.0.0.1,::1'

/**
 * The local proxy ports worth probing, in the order a hit is preferred. These
 * are defaults of shipping proxy clients, not invented ports: Clash / Clash
 * Verge / Mihomo, v2rayN, V2Ray, Surge, then the generic HTTP proxies.
 */
export const DEFAULT_PROXY_CANDIDATES = [
  { url: 'http://127.0.0.1:7890', label: 'Clash / Clash Verge / Mihomo mixed port' },
  { url: 'http://127.0.0.1:7897', label: 'Clash Verge Rev mixed port' },
  { url: 'http://127.0.0.1:7891', label: 'Clash alternate mixed port' },
  { url: 'http://127.0.0.1:10809', label: 'v2rayN HTTP port' },
  { url: 'http://127.0.0.1:1080', label: 'V2Ray / SOCKS port' },
  { url: 'http://127.0.0.1:6152', label: 'Surge HTTP port' },
  { url: 'http://127.0.0.1:8888', label: 'Charles / Fiddler' },
  { url: 'http://127.0.0.1:8080', label: 'generic HTTP proxy' },
  { url: 'http://127.0.0.1:3128', label: 'Squid' },
  { url: 'http://127.0.0.1:8118', label: 'Privoxy' },
]

/** Environment variables consulted for an already-configured proxy, in order. */
const PROXY_ENV_KEYS = ['HTTPS_PROXY', 'https_proxy', 'ALL_PROXY', 'all_proxy', 'HTTP_PROXY', 'http_proxy']

/**
 * Parse a proxy URL into its parts, defaulting a bare `host:port` to `http://`.
 * @param {unknown} raw - the candidate value.
 * @returns {{ url: string, host: string, port: number, protocol: string } | null} the parsed proxy, or null.
 */
export function parseProxyUrl(raw) {
  if (typeof raw !== 'string') return null
  const trimmed = raw.trim()
  if (trimmed.length === 0) return null
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  let parsed
  try {
    parsed = new URL(withScheme)
  } catch {
    return null
  }
  const protocol = parsed.protocol.replace(/:$/, '').toLowerCase()
  if (protocol !== 'http' && protocol !== 'https' && protocol !== 'socks' && protocol !== 'socks5' && protocol !== 'socks4') {
    return null
  }
  const port = parsed.port.length > 0
    ? Number.parseInt(parsed.port, 10)
    : (protocol === 'https' ? 443 : 1080)
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null
  if (parsed.hostname.length === 0) return null
  return { url: parsed.toString().replace(/\/$/, ''), host: parsed.hostname, port, protocol }
}

/**
 * Probe one TCP endpoint.
 * @param {object} options - the probe.
 * @param {string} options.host - host to connect to.
 * @param {number} options.port - port to connect to.
 * @param {number} [options.timeoutMs] - connect timeout.
 * @param {AbortSignal} [options.signal] - caller cancellation.
 * @returns {Promise<boolean>} whether the connection was accepted.
 */
export function probeTcp({ host, port, timeoutMs = PROBE_TIMEOUT_MS, signal }) {
  return new Promise((resolve) => {
    let settled = false
    const socket = connect({ host, port })

    function finish(reachable) {
      if (settled) return
      settled = true
      signal?.removeEventListener('abort', onAbort)
      socket.destroy()
      resolve(reachable)
    }

    function onAbort() {
      finish(false)
    }

    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
    if (signal?.aborted === true) {
      finish(false)
      return
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Build the candidate list a probe walks: caller-supplied entries first (a
 * deployment knows its own proxy), then the shipping-client defaults, deduped
 * by URL and skipped when malformed.
 * @param {unknown} extra - `proxyCandidates` from Config or the settings file.
 * @returns {{ url: string, label: string }[]} the ordered candidate list.
 */
export function buildProxyCandidates(extra) {
  const list = []
  const seen = new Set()
  const push = (url, label) => {
    const parsed = parseProxyUrl(url)
    if (parsed === null || seen.has(parsed.url)) return
    seen.add(parsed.url)
    list.push({ url: parsed.url, label })
  }
  if (Array.isArray(extra)) {
    for (const entry of extra) {
      push(typeof entry === 'string' ? entry : entry?.url, `configured candidate${typeof entry === 'object' && entry?.label ? ` (${entry.label})` : ''}`)
    }
  }
  for (const candidate of DEFAULT_PROXY_CANDIDATES) push(candidate.url, candidate.label)
  return list
}

/**
 * Read the proxy git itself was configured with. vcpkg clones its registry
 * through git, so a proxy that only git knows about still unblocks installs.
 * @param {object} options - the lookup.
 * @param {AbortSignal} [options.signal] - caller cancellation.
 * @param {string} [options.gitPath] - git executable.
 * @param {NodeJS.ProcessEnv} [options.env] - environment for the git call.
 * @returns {Promise<{ url: string | null, raw: string | null, error: string | null }>} the configured proxy.
 */
export async function readGitProxy({ signal, gitPath = 'git', env } = {}) {
  const result = await runProcess({
    command: gitPath,
    args: ['config', '--global', '--get', 'http.proxy'],
    env,
    signal,
    timeoutMs: 10_000,
    maxOutputBytes: 4 * 1024,
  })
  if (result.spawnError !== null) return { url: null, raw: null, error: `git unavailable: ${result.spawnError}` }
  const raw = (result.stdout.split('\n')[0] ?? '').trim()
  if (raw.length === 0) return { url: null, raw: null, error: null }
  // `git config --get` exits 1 for an unset key, which is the common case.
  const parsed = parseProxyUrl(raw)
  return { url: parsed?.url ?? null, raw, error: parsed === null ? `unsupported http.proxy value ${JSON.stringify(raw)}` : null }
}

/**
 * Probe every candidate in parallel and return the first reachable one.
 * @param {object} options - the detection.
 * @param {{ url: string, label: string }[]} options.candidates - ordered candidates.
 * @param {number} [options.timeoutMs] - per-candidate connect timeout.
 * @param {AbortSignal} [options.signal] - caller cancellation.
 * @returns {Promise<{ selected: { url: string, label: string } | null, probes: object[] }>} the selection and full probe log.
 */
export async function detectLocalProxy({ candidates, timeoutMs = PROBE_TIMEOUT_MS, signal }) {
  const probes = await Promise.all(candidates.map(async (candidate) => {
    const parsed = parseProxyUrl(candidate.url)
    const reachable = parsed !== null && await probeTcp({ host: parsed.host, port: parsed.port, timeoutMs, signal })
    return { url: candidate.url, label: candidate.label, reachable }
  }))
  return { selected: probes.find((probe) => probe.reachable) ?? null, probes }
}

/** Memoized resolutions, keyed by the inputs that can change the answer. */
const resolutionCache = new Map()

/**
 * Drop every memoized resolution. Called after `vcpkg_proxy set` / `clear` so
 * the next invocation cannot replay the answer the pin just replaced.
 * @returns {void}
 */
export function invalidateProxyCache() {
  resolutionCache.clear()
}

/**
 * Resolve the one proxy every vcpkg invocation for this caller should use.
 * @param {object} options - the resolution inputs.
 * @param {object} [options.config] - the plugin Config.
 * @param {Record<string, unknown>} [options.settings] - the parsed settings file values.
 * @param {NodeJS.ProcessEnv} [options.env] - environment to inspect.
 * @param {AbortSignal} [options.signal] - caller cancellation.
 * @param {boolean} [options.force] - bypass the memoized resolution.
 * @returns {Promise<object>} the resolution report, also safe to render verbatim.
 */
export async function resolveProxy({ config = {}, settings = {}, env = process.env, signal, force = false } = {}) {
  const pinned = parseProxyUrl(settings.proxy)
  const configured = parseProxyUrl(config.proxy)
  const envKey = PROXY_ENV_KEYS.find((key) => typeof env[key] === 'string' && env[key].trim().length > 0)
  const envUrl = envKey === undefined ? null : parseProxyUrl(env[envKey])
  const autoDetect = config.autoDetectProxy !== false
  const candidates = buildProxyCandidates(settings.proxyCandidates ?? config.proxyCandidates)
  const cacheKey = JSON.stringify([pinned?.url ?? null, configured?.url ?? null, envUrl?.url ?? null, autoDetect, candidates.map((c) => c.url)])

  const cached = resolutionCache.get(cacheKey)
  if (!force && cached !== undefined && Date.now() - cached.at < PROXY_CACHE_TTL_MS) {
    return { ...cached.value, cached: true }
  }

  const warnings = []
  const report = {
    url: null,
    source: 'none',
    sourceDetail: 'no proxy configured and none detected',
    noProxy: buildNoProxy(settings.noProxy ?? config.noProxy ?? env.NO_PROXY ?? env.no_proxy),
    candidates: [],
    git: { configured: null, error: null },
    warnings,
    autoDetect,
    resolvedAt: Date.now(),
    cached: false,
  }

  const decide = (url, source, sourceDetail) => {
    report.url = url
    report.source = source
    report.sourceDetail = sourceDetail
  }

  if (pinned !== null) {
    decide(pinned.url, 'settings', `pinned in the plugin settings file`)
  } else if (settings.proxy !== undefined && pinned === null) {
    warnings.push(`ignoring unsupported \`proxy\` value in the settings file: ${JSON.stringify(settings.proxy)}`)
  }

  if (report.url === null && configured !== null) {
    decide(configured.url, 'config', 'set by the plugin Config (a profile patch layer)')
  } else if (report.url === null && config.proxy !== undefined && configured === null) {
    warnings.push(`ignoring unsupported Config \`proxy\` value: ${JSON.stringify(config.proxy)}`)
  }

  if (report.url === null && envUrl !== null) {
    decide(envUrl.url, 'environment', `${envKey} is set in the Harness environment`)
  } else if (report.url === null && envKey !== undefined && envUrl === null) {
    warnings.push(`ignoring unparseable ${envKey}=${JSON.stringify(env[envKey])}`)
  }

  if (report.url === null) {
    const git = await readGitProxy({ signal, env })
    report.git = { configured: git.raw, error: git.error }
    if (git.url !== null) decide(git.url, 'git-config', 'git config --global http.proxy')
  }

  if (report.url === null && autoDetect) {
    const detection = await detectLocalProxy({ candidates, signal })
    report.candidates = detection.probes
    if (detection.selected !== null) {
      decide(detection.selected.url, 'auto-detect', `first reachable local proxy port (${detection.selected.label})`)
    }
  } else if (report.url === null && !autoDetect) {
    report.candidates = candidates.map((candidate) => ({ ...candidate, reachable: null }))
    warnings.push('automatic local proxy detection is disabled (autoDetectProxy: false)')
  }

  resolutionCache.set(cacheKey, { at: Date.now(), value: report })
  return report
}

/**
 * Compose the effective `NO_PROXY` value, always keeping loopback direct.
 * @param {unknown} callerList - a caller-supplied list, if any.
 * @returns {string} the comma-separated list.
 */
export function buildNoProxy(callerList) {
  const entries = []
  const seen = new Set()
  for (const raw of [callerList, DEFAULT_NO_PROXY]) {
    if (typeof raw !== 'string') continue
    for (const part of raw.split(',')) {
      const trimmed = part.trim()
      if (trimmed.length === 0 || seen.has(trimmed.toLowerCase())) continue
      seen.add(trimmed.toLowerCase())
      entries.push(trimmed)
    }
  }
  return entries.join(',')
}

/**
 * The child environment for one vcpkg invocation. Both letter cases are set:
 * curl and git read the lowercase names, and a few tools in vcpkg's dependency
 * chain read the uppercase ones.
 * @param {object} resolution - a {@link resolveProxy} report.
 * @param {NodeJS.ProcessEnv} [baseEnv] - the environment to extend.
 * @returns {NodeJS.ProcessEnv} a fresh environment for the child process.
 */
export function proxyEnvFor(resolution, baseEnv = process.env) {
  const env = { ...baseEnv }
  if (typeof resolution?.url === 'string' && resolution.url.length > 0) {
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
      env[key] = resolution.url
    }
  }
  const noProxy = resolution?.noProxy
  if (typeof noProxy === 'string' && noProxy.length > 0) {
    env.NO_PROXY = noProxy
    env.no_proxy = noProxy
  }
  return env
}

/**
 * One-line summary of a resolution, for a tool result header.
 * @param {object} resolution - a {@link resolveProxy} report.
 * @returns {string} the summary.
 */
export function describeProxy(resolution) {
  if (resolution?.url == null) return 'no proxy (direct connection)'
  return `${resolution.url} (${resolution.source})`
}

/**
 * Path to the platform's null device, for a curl body discard.
 * @returns {string} the null device path.
 */
export function nullDevice() {
  return process.platform === 'win32' ? 'NUL' : '/dev/null'
}

/**
 * Default end-to-end probe target: the vcpkg registry repository, which is what
 * `vcpkg install` clones and fetches its version baseline from.
 */
export const DEFAULT_PROBE_TARGET = 'https://github.com/microsoft/vcpkg'

/**
 * Run a real HTTPS request through `curl`, with and without the resolved proxy.
 * A TCP probe proves only that something listens on the port; this proves the
 * proxy actually carries TLS to the registry host.
 * @param {object} options - the probe.
 * @param {string | null} options.proxyUrl - proxy to route through, or null for direct.
 * @param {string} [options.targetUrl] - the URL to request.
 * @param {AbortSignal} [options.signal] - caller cancellation.
 * @param {number} [options.timeoutSeconds] - curl `--max-time`.
 * @returns {Promise<object>} `{ attempted, ok, httpCode, exitCode, error, durationMs }`.
 */
export async function probeHttp({ proxyUrl, targetUrl = DEFAULT_PROBE_TARGET, signal, timeoutSeconds = 12 }) {
  // curl.exe ships with Windows 10 1803+; its absence is reported through
  // `attempted: false` rather than thrown, because the TCP probe already
  // answered the reachability question.
  const args = [
    '--silent', '--show-error', '--head', '--location',
    '--output', nullDevice(),
    '--write-out', '%{http_code}',
    '--max-time', String(timeoutSeconds),
  ]
  if (proxyUrl !== null && proxyUrl !== undefined) args.push('--proxy', proxyUrl)
  args.push(targetUrl)
  const result = await runProcess({
    command: 'curl',
    args,
    signal,
    timeoutMs: (timeoutSeconds + 5) * 1000,
    maxOutputBytes: 4 * 1024,
  })
  const code = (result.stdout ?? '').trim()
  const httpCode = /^\d{3}$/.test(code) ? Number.parseInt(code, 10) : null
  const stderr = (result.stderr ?? '').trim()
  return {
    proxy: proxyUrl ?? null,
    target: targetUrl,
    attempted: result.spawnError === null,
    ok: result.code === 0 && httpCode !== null && httpCode >= 200 && httpCode < 400,
    httpCode,
    exitCode: result.code,
    error: result.spawnError ?? (stderr.length > 0 ? stderr.split('\n').slice(-3).join(' ').slice(0, 600) : null),
    durationMs: result.durationMs,
  }
}

/**
 * Decide whether a vcpkg failure looks like a network problem, so a tool can
 * point at `vcpkg_proxy probe` instead of leaving a raw curl error in the log.
 * @param {string} text - combined stdout and stderr of the failed run.
 * @returns {boolean} whether the text matches a known network failure shape.
 */
export function looksLikeNetworkFailure(text) {
  if (typeof text !== 'string' || text.length === 0) return false
  return /curl: \(\d+\)|Could not resolve host|Failed to connect|Connection (refused|reset|timed out)|Operation timed out|SSL certificate problem|TLS handshake|schannel|proxy|CONNECT tunnel failed|Failed to download from|Recv failure|gnutls_handshake|Early EOF|RPC failed/i.test(text)
}

/**
 * Render a resolution report as model-facing text.
 * @param {object} resolution - a {@link resolveProxy} report.
 * @returns {string} the rendered report.
 */
export function renderProxyResolution(resolution) {
  const lines = [`proxy: ${describeProxy(resolution)}`]
  lines.push(`  source: ${resolution.source} — ${resolution.sourceDetail}`)
  if (resolution.noProxy) lines.push(`  NO_PROXY: ${resolution.noProxy}`)
  if (resolution.git?.configured) lines.push(`  git http.proxy: ${resolution.git.configured}`)
  if (Array.isArray(resolution.candidates) && resolution.candidates.length > 0) {
    const reachable = resolution.candidates.filter((candidate) => candidate.reachable === true)
    lines.push(`  local ports probed: ${resolution.candidates.length}; reachable: ${reachable.length === 0 ? 'none' : reachable.map((c) => c.url).join(', ')}`)
  }
  for (const warning of resolution.warnings ?? []) lines.push(`  warning: ${warning}`)
  return lines.join('\n')
}

/**
 * Convert an unknown thrown value into the shape the tools report.
 * @param {unknown} error - the thrown value.
 * @returns {string} one line.
 */
export function proxyErrorText(error) {
  return messageOf(error)
}
