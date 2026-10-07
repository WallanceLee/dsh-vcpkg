/**
 * `vcpkg_search` — find ports and read their features.
 *
 * @module dsh-vcpkg/tools/search
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { prepareInvocation, networkHint, networkSummary } from '../core/invocation.js'
import { looksLikeNetworkFailure } from '../core/proxy.js'
import { parseSearchOutput } from '../core/registry.js'
import { runProcess } from '../core/runner.js'
import { field, lines, text, warningBlock } from './common.js'

const DESCRIPTION = [
  'Search the vcpkg port registry for ports whose name or description matches a term, and list the features each',
  'matching port offers. Reports the port version the current registry checkout would install.',
  '',
  'Use it to find the correct port name for a library before adding it to vcpkg.json, and to discover the',
  'feature names a port accepts (for example the `iconv` feature of `gdal`) before requesting them.',
  '',
  'This runs `vcpkg search`, which reads the local registry checkout and does not download ports, so it is cheap.',
  'An empty result usually means the registry checkout is stale, not that the port is missing.',
].join(' ')

/**
 * Render the search result.
 * @param {object} value - the canonical value.
 * @returns {{ type: 'text', text: string }[]} the content blocks.
 */
function render(value) {
  const body = [`search "${value.query}" — ${value.ports.length} port${value.ports.length === 1 ? '' : 's'}, ${value.features.length} feature${value.features.length === 1 ? '' : 's'}`, networkSummary({ proxy: value.proxy })]
  for (const port of value.ports) {
    body.push(`  ${port.name}${port.version === null ? '' : ` ${port.version}`}${port.description.length === 0 ? '' : `\n      ${port.description}`}`)
  }
  const byPort = new Map()
  for (const feature of value.features) {
    if (!byPort.has(feature.port)) byPort.set(feature.port, [])
    byPort.get(feature.port).push(feature)
  }
  for (const [port, list] of byPort) {
    body.push(`  ${port} features:`)
    for (const feature of list) body.push(`      ${feature.feature} — ${feature.description}`)
  }
  if (value.ports.length === 0 && value.features.length === 0) {
    body.push('  no matches. The registry checkout may be stale; update it with `git pull` in the vcpkg root.')
  }
  body.push(field('registry', value.root))
  if (value.exitCode !== 0) body.push(`vcpkg exited with code ${value.exitCode}`)
  if (value.stderrTail.length > 0) body.push(`stderr:\n${value.stderrTail}`)
  if (value.networkSuspected) body.push(`network failure suspected. ${networkHint({ proxy: value.proxy })}`)
  body.push(warningBlock(value.warnings))
  return text(lines(body))
}

/** Notices vcpkg prints on stderr that carry no diagnostic value. */
const STDERR_NOISE = /^(The result may be outdated|If your port is not listed)/i

/**
 * Build the tool.
 * @param {object} options - the registration inputs.
 * @param {object} options.config - the plugin Config.
 * @returns {object} the tool definition.
 */
export function vcpkgSearchTool({ config }) {
  return defineTool({
    name: 'vcpkg_search',
    description: DESCRIPTION,
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: 'Term to match against port names and descriptions, for example "draco" or "geospatial".',
      },
      projectDir: {
        type: 'string',
        description: 'Directory to resolve the vcpkg tree from. Defaults to the session workspace.',
      },
      triplet: {
        type: 'string',
        description: 'Triplet whose registry view to search. Defaults to the host triplet.',
      },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => render(value) },
    async execute(args, exec) {
      const invocation = await prepareInvocation({ exec, config, args, signal: exec.signal })
      const environment = invocation.environment
      if (environment.binary === null || environment.root === null) {
        throw new Error(`${environment.warnings[0] ?? 'no bootstrapped vcpkg tree was found'}; run vcpkg_info to see which roots were examined`)
      }
      const query = args.query.trim()
      if (query.length === 0) throw new Error('`query` must not be empty')

      const argv = ['search', query]
      if (environment.triplet !== null) argv.push(`--triplet=${environment.triplet}`)
      const result = await runProcess({
        command: environment.binary,
        args: argv,
        cwd: invocation.projectDir,
        env: invocation.env,
        signal: exec.signal,
        timeoutMs: 180_000,
      })

      const parsed = parseSearchOutput(result.stdout)
      const stderrTail = result.stderr
        .trim()
        .split('\n')
        .filter((line) => !STDERR_NOISE.test(line.trim()))
        .slice(-12)
        .join('\n')
      const combined = `${result.stdout}\n${result.stderr}`
      return {
        query,
        root: environment.root,
        triplet: environment.triplet,
        proxy: { url: invocation.proxy.url, source: invocation.proxy.source },
        ports: parsed.ports,
        features: parsed.features,
        exitCode: result.code,
        stderrTail,
        truncated: result.truncated,
        timedOut: result.timedOut,
        aborted: result.aborted,
        networkSuspected: (result.code !== 0 || parsed.ports.length === 0) && looksLikeNetworkFailure(combined),
        warnings: invocation.warnings,
      }
    },
    timeoutMs: 240_000,
  })
}
