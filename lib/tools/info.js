/**
 * `vcpkg_info` — which vcpkg tree is in play, and whether it can build.
 *
 * @module dsh-vcpkg/tools/info
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { prepareInvocation } from '../core/invocation.js'
import { field, lines, text, warningBlock } from './common.js'

const DESCRIPTION = [
  'Report the vcpkg installation this workspace would build against: the resolved root and how it was found,',
  'the vcpkg version and checkout commit, the triplet that would be used, the CMake toolchain file, the',
  'manifest that was located, and the proxy the vcpkg tools would use for network access.',
  '',
  'Call this first when a C++ build fails on a missing or wrong vcpkg dependency, or before the first vcpkg',
  'operation in a session. It never starts a build and changes nothing.',
  '',
  'It also reports the disagreements worth knowing about: VCPKG_ROOT pointing somewhere other than the tree',
  'in use, a root that exists but was never bootstrapped, and a manifest baseline the checkout cannot reach.',
].join(' ')

/**
 * Render the manifest summary.
 * @param {object | null} manifest - the summary, or null.
 * @returns {string[]} the lines.
 */
function manifestLines(manifest) {
  if (manifest === null) return ['manifest: none found near this workspace']
  if (manifest.error !== null && manifest.error !== undefined) {
    return [`manifest: ${manifest.path} (${manifest.foundBy})`, `  UNREADABLE: ${manifest.error}`]
  }
  const featureNames = Array.isArray(manifest.featureNames) ? manifest.featureNames : []
  return [
    `manifest: ${manifest.path} (${manifest.foundBy})`,
    field('  name', manifest.name),
    field('  version', manifest.version),
    `  declared dependencies: ${manifest.dependencyCount ?? 0}`,
    field('  declared features', featureNames.length === 0 ? null : featureNames.join(', ')),
    field('  builtin-baseline', manifest.builtinBaseline),
    manifest.baselineReachable === false
      ? '  WARNING: this checkout cannot reach that baseline commit; `vcpkg install` fails until the tree is updated (run `git pull` in the vcpkg root).'
      : null,
  ].filter((line) => typeof line === 'string' && line.length > 0)
}

/**
 * Render the environment report.
 * @param {object} value - the canonical value.
 * @returns {{ type: 'text', text: string }[]} the content blocks.
 */
function render(value) {
  const body = lines(
    value.root === null
      ? 'vcpkg root: NOT FOUND — no bootstrapped vcpkg tree was found for this workspace.'
      : `vcpkg root: ${value.root}`,
    field('  found via', value.rootSource),
    field('  binary', value.binary),
    field('  version', value.version === null ? null : (value.version.raw ?? `unavailable (${value.version.error})`)),
    field('  checkout HEAD', value.treeHead),
    field('  toolchain file', value.hasToolchain ? value.toolchainFile : 'MISSING (scripts/buildsystems/vcpkg.cmake absent)'),
    field('  VCPKG_ROOT env', value.envVcpkgRoot ?? 'unset'),
    `triplet: ${value.triplet ?? '<unresolved>'} (from ${value.tripletSource})`,
    `network: ${value.proxy.url ?? 'direct connection'}${value.proxy.url === null ? '' : ` (${value.proxy.source})`}`,
    ...manifestLines(value.manifest),
    value.candidates.length === 0
      ? null
      : ['candidate roots examined:', ...value.candidates.map((candidate) => `  ${candidate.usable ? 'OK  ' : '--  '} ${candidate.path} — ${candidate.note} (${candidate.source})`)],
    warningBlock(value.warnings),
  )
  return text(body)
}

/**
 * Build the tool.
 * @param {object} options - the registration inputs.
 * @param {object} options.config - the plugin Config.
 * @returns {object} the tool definition.
 */
export function vcpkgInfoTool({ config }) {
  return defineTool({
    name: 'vcpkg_info',
    description: DESCRIPTION,
    parameters: {
      projectDir: {
        type: 'string',
        description: 'Directory to resolve the vcpkg tree and manifest from. Defaults to the session workspace.',
      },
      triplet: {
        type: 'string',
        description: "Triplet to report. Defaults to VCPKG_DEFAULT_TRIPLET, else this host's default triplet.",
      },
    },
    output: { schema: { type: 'json' }, render: (_args, value) => render(value) },
    async execute(args, exec) {
      const invocation = await prepareInvocation({
        exec,
        config,
        args,
        signal: exec.signal,
        includeManifest: true,
        checkBaseline: true,
      })
      const environment = invocation.environment
      return {
        projectDir: invocation.projectDir,
        root: environment.root,
        rootSource: environment.rootSource,
        binary: environment.binary,
        toolchainFile: environment.toolchainFile,
        hasToolchain: environment.hasToolchain,
        version: environment.version,
        treeHead: environment.treeHead,
        triplet: environment.triplet,
        tripletSource: environment.tripletSource,
        envVcpkgRoot: environment.envVcpkgRoot,
        candidates: environment.candidates.map((candidate) => ({
          path: candidate.path,
          source: candidate.source,
          usable: candidate.usable,
          note: candidate.note,
        })),
        manifest: invocation.manifest === null ? null : {
          path: invocation.manifest.path,
          foundBy: invocation.manifest.foundBy,
          error: invocation.manifest.error,
          name: invocation.manifest.manifest?.name ?? null,
          version: invocation.manifest.manifest?.version ?? null,
          builtinBaseline: invocation.manifest.manifest?.builtinBaseline ?? null,
          dependencyCount: invocation.manifest.manifest?.dependencies.length ?? 0,
          featureNames: invocation.manifest.manifest === null ? [] : Object.keys(invocation.manifest.manifest.features),
          baselineReachable: invocation.manifest.baselineReachable,
        },
        proxy: {
          url: invocation.proxy.url,
          source: invocation.proxy.source,
          sourceDetail: invocation.proxy.sourceDetail,
          noProxy: invocation.proxy.noProxy,
        },
        settingsPath: invocation.settingsPath,
        warnings: invocation.warnings,
      }
    },
    timeoutMs: 60_000,
  })
}
