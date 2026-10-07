/**
 * `vcpkg_proxy`: the network path vcpkg takes, and how to fix it.
 *
 * The failure this diagnoses is hard to see from the outside. When a registry
 * fetch cannot reach GitHub, vcpkg reports a curl exit code thousands of lines
 * into a build log, and the cause is a property of the machine rather than of
 * the build.
 *
 * @module dsh-vcpkg/tools/proxy
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import {
  DEFAULT_PROBE_TARGET,
  PROBE_TIMEOUT_MS,
  buildProxyCandidates,
  detectLocalProxy,
  invalidateProxyCache,
  parseProxyUrl,
  probeHttp,
  readGitProxy,
  resolveProxy,
} from '../core/proxy.js'
import { readSettings, settingsPath, writeSettings } from '../core/settings.js'
import { field, lines, text, warningBlock } from './common.js'

const DESCRIPTION = [
  'Inspect and control the proxy that every vcpkg tool routes its network access through.',
  '',
  'vcpkg downloads ports through libcurl and clones its registry through git, and both read the standard proxy',
  'environment variables. On a network where the registry is only reachable through a local proxy, an unset',
  'variable shows up as a bare `curl: (7) Failed to connect` inside a long build. This tool answers that.',
  '',
  'It runs automatically before every other vcpkg tool, so you only need to call it when something failed.',
  'Actions:',
  '  status — report the proxy in effect, where it came from, and which local proxy ports are reachable.',
  '  probe  — additionally send a real HTTPS request to the vcpkg registry, direct and through the proxy, and',
  '           test every candidate port end to end. Use this after a download failure.',
  '  set    — pin a proxy for this machine, persisted across sessions. Use the URL of a reachable candidate.',
  '  clear  — remove the pin and return to automatic detection.',
].join('\n')

/**
 * Render the resolution header shared by every action.
 * @param {string[]} into - the accumulating lines.
 * @param {object} proxy - the resolution report.
 * @returns {string[]} the lines.
 */
function proxyLines(into, proxy) {
  into.push(`proxy in effect: ${proxy.url ?? 'none (direct connection)'}`)
  into.push(`  source: ${proxy.source} — ${proxy.sourceDetail}`)
  into.push(`  NO_PROXY: ${proxy.noProxy}`)
  if (proxy.git?.configured !== null && proxy.git?.configured !== undefined) {
    into.push(`  git config http.proxy: ${proxy.git.configured}`)
  }
  return into
}

/**
 * Render the candidate port table.
 * @param {object[]} candidates - the candidates.
 * @returns {string[]} the lines.
 */
function candidateLines(candidates) {
  if (!Array.isArray(candidates) || candidates.length === 0) return []
  return [
    'local proxy ports:',
    ...candidates.map((candidate) => {
      const mark = candidate.reachable === true ? 'OPEN  ' : candidate.reachable === false ? 'closed' : 'untested'
      return `  ${mark}  ${candidate.url}  ${candidate.label}`
    }),
  ]
}

/**
 * Render the end-to-end probe results.
 * @param {object[]} probes - the probe results.
 * @returns {string[]} the lines.
 */
function probeLines(probes) {
  if (!Array.isArray(probes) || probes.length === 0) return []
  return [
    'end-to-end HTTPS requests to the vcpkg registry:',
    ...probes.map((probe) => {
      const label = probe.proxy === null ? 'direct' : `via ${probe.proxy}`
      if (!probe.attempted) return `  FAIL  ${label} — curl is unavailable, so only the TCP probe could run`
      if (probe.ok) return `  OK    ${label} — HTTP ${probe.httpCode} in ${probe.durationMs} ms`
      return `  FAIL  ${label} — ${probe.error ?? `HTTP ${probe.httpCode ?? 'n/a'}`}`
    }),
  ]
}

/**
 * Render the tool result.
 * @param {object} value - the canonical value.
 * @returns {{ type: 'text', text: string }[]} the content blocks.
 */
function render(value) {
  const body = []
  if (value.action === 'set') {
    body.push(value.changed.length === 0
      ? `proxy pin unchanged in ${value.settingsPath}`
      : `pinned ${value.proxy.url} in ${value.settingsPath} (changed: ${value.changed.join(', ')})`)
  } else if (value.action === 'clear') {
    body.push(value.changed.length === 0
      ? `nothing to clear in ${value.settingsPath}`
      : `cleared ${value.changed.join(', ')} from ${value.settingsPath}`)
  }
  proxyLines(body, value.proxy)
  body.push(...candidateLines(value.candidates))
  body.push(...probeLines(value.probes))
  if (value.action === 'status' && value.proxy.url === null) {
    body.push('Nothing is configured for vcpkg network access, so it connects directly. If a download fails, run action "probe".')
  }
  if (value.action === 'probe') {
    const working = value.probes.filter((probe) => probe.ok)
    body.push(working.length === 0
      ? `No route to ${value.targetUrl} worked. If a local proxy client is running, confirm its mixed or HTTP port, then pin it: vcpkg_proxy action "set" proxy "http://127.0.0.1:<port>".`
      : `Reachable now: ${working.map((probe) => probe.proxy ?? 'direct').join(', ')}.`)
  }
  body.push(field('settings file', value.settingsPath))
  body.push(warningBlock(value.warnings))
  return text(lines(body))
}

/**
 * Build the tool.
 * @param {object} options - the registration inputs.
 * @param {object} options.config - the plugin Config.
 * @returns {object} the tool definition.
 */
export function vcpkgProxyTool({ config }) {
  return defineTool({
    name: 'vcpkg_proxy',
    description: DESCRIPTION,
    parameters: {
      action: {
        type: 'string',
        required: true,
        enum: ['status', 'probe', 'set', 'clear'],
        description: 'Which operation to run. "status" reports without touching the network beyond local port checks.',
      },
      proxy: {
        type: 'string',
        description: 'For action "set": the proxy URL to pin, for example "http://127.0.0.1:7890".',
      },
      noProxy: {
        type: 'string',
        description: 'For action "set": extra NO_PROXY hosts, comma separated. Loopback is always kept direct.',
      },
      targetUrl: {
        type: 'string',
        description: `For action "probe": the URL to test. Defaults to ${DEFAULT_PROBE_TARGET}, the vcpkg registry repository.`,
      },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => render(value) },
    async execute(args, exec) {
      const settingsRead = await readSettings()
      const settings = settingsRead.values
      const warnings = []
      if (settingsRead.warning !== undefined) warnings.push(settingsRead.warning)

      let changed = []
      if (args.action === 'set') {
        const parsed = parseProxyUrl(args.proxy)
        if (parsed === null) {
          throw new Error(`\`proxy\` must be a proxy URL such as "http://127.0.0.1:7890"; received ${JSON.stringify(args.proxy ?? null)}`)
        }
        const written = await writeSettings({ proxy: parsed.url, noProxy: args.noProxy ?? null })
        changed = written.changed
        invalidateProxyCache()
      } else if (args.action === 'clear') {
        const written = await writeSettings({ proxy: null, noProxy: null })
        changed = written.changed
        invalidateProxyCache()
      }

      const currentSettings = (await readSettings()).values
      const proxy = await resolveProxy({ config, settings: currentSettings, force: true })

      let candidates = proxy.candidates
      let probes = []
      if (args.action === 'probe') {
        const targetUrl = typeof args.targetUrl === 'string' && args.targetUrl.trim().length > 0
          ? args.targetUrl.trim()
          : DEFAULT_PROBE_TARGET
        const listed = buildProxyCandidates(currentSettings.proxyCandidates ?? config.proxyCandidates)
        const detection = await detectLocalProxy({ candidates: listed, timeoutMs: PROBE_TIMEOUT_MS, signal: exec.signal })
        candidates = detection.probes
        const toTest = [{ url: null }, ...detection.probes.filter((probe) => probe.reachable)]
        probes = await Promise.all(toTest.map((candidate) => probeHttp({
          proxyUrl: candidate.url,
          targetUrl,
          signal: exec.signal,
        })))
        if (detection.selected === null) {
          warnings.push('no local proxy port accepted a connection; a proxy client may be stopped, or it may listen on a port outside the known set.')
        }
        return {
          action: args.action,
          targetUrl,
          proxy: pickProxy(proxy),
          candidates,
          probes,
          changed,
          settingsPath: settingsPath(),
          warnings,
        }
      }

      if (args.action === 'status' && proxy.url === null) {
        const git = await readGitProxy({ signal: exec.signal })
        if (git.error !== null) warnings.push(git.error)
      }

      return {
        action: args.action,
        targetUrl: null,
        proxy: pickProxy(proxy),
        candidates,
        probes,
        changed,
        settingsPath: settingsPath(),
        warnings,
      }
    },
    timeoutMs: 120_000,
  })
}

/**
 * Project a resolution report down to the fields a caller consumes.
 * @param {object} proxy - the resolution report.
 * @returns {object} the projection.
 */
function pickProxy(proxy) {
  return {
    url: proxy.url,
    source: proxy.source,
    sourceDetail: proxy.sourceDetail,
    noProxy: proxy.noProxy,
    autoDetect: proxy.autoDetect,
    git: proxy.git,
  }
}
