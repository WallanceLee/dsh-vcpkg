/**
 * `vcpkg_manifest` — what the manifest declares versus what is installed.
 *
 * @module dsh-vcpkg/tools/manifest
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { dirname } from 'node:path'

import { resolveUserPath } from '../core/environment.js'
import { prepareInvocation } from '../core/invocation.js'
import { reconcile, renderManifest } from '../core/manifest.js'
import { candidateInstallRoots, readInstalledPackages, selectInstallRoot } from '../core/status-db.js'
import { field, lines, text, warningBlock } from './common.js'

const DESCRIPTION = [
  'Read the project\'s vcpkg.json and diff its declared dependencies against the packages actually present in the',
  'install root, reporting what is satisfied, what is missing entirely, and which declared features an installed',
  'port was built without.',
  '',
  'Use it to answer "why does the build not find this library" before running an install: a manifest listing',
  'twenty ports against an empty install root and a manifest missing one port look identical from a compiler',
  'error, and this tells them apart in one call.',
  '',
  'Reads files only; it never runs vcpkg and never touches the network.',
].join(' ')

/**
 * Render the manifest report.
 * @param {object} value - the canonical value.
 * @returns {{ type: 'text', text: string }[]} the content blocks.
 */
function render(value) {
  const manifest = value.manifest
  const body = [
    renderManifest({
      manifest,
      reconciliation: value.reconciliation,
      installRoot: value.installRoot,
      triplet: value.triplet,
    }),
    field('found via', value.foundBy),
  ]
  if (manifest.overrides.length > 0) {
    body.push(`overrides: ${manifest.overrides.map((entry) => `${entry.name}@${entry.version ?? '?'}`).join(', ')}`)
  }
  if (value.reconciliation !== null && value.reconciliation.missing.length > 0) {
    body.push('')
    body.push(`Install the ${value.reconciliation.missing.length} missing port(s) with vcpkg_install: manifestRoot "${value.manifestRoot}".`)
  }
  if (value.installRoot === null) {
    body.push('')
    body.push('locations checked for an install root:')
    body.push(...value.checked.map((entry) => `  --  ${entry.path}`))
  }
  body.push(warningBlock(value.warnings))
  return text(lines(body))
}

/**
 * Build the tool.
 * @param {object} options - the registration inputs.
 * @param {object} options.config - the plugin Config.
 * @returns {object} the tool definition.
 */
export function vcpkgManifestTool({ config }) {
  return defineTool({
    name: 'vcpkg_manifest',
    description: DESCRIPTION,
    parameters: {
      manifestPath: {
        type: 'string',
        description: 'Path to vcpkg.json, or to the directory holding it. Defaults to searching from the session workspace.',
      },
      projectDir: {
        type: 'string',
        description: 'Directory to begin the manifest and install-root search from. Defaults to the session workspace.',
      },
      installRoot: {
        type: 'string',
        description: 'Compare against exactly this `vcpkg_installed` directory instead of searching for one.',
      },
      triplet: {
        type: 'string',
        description: 'Triplet to report alongside the comparison. Defaults to the host triplet.',
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
      })
      const located = invocation.manifest
      if (located === null) {
        throw new Error(`no vcpkg.json found from ${invocation.projectDir}; pass \`manifestPath\` or \`projectDir\``)
      }
      if (located.manifest === null) throw new Error(located.error ?? `cannot read ${located.path}`)

      const manifest = located.manifest
      const manifestRoot = dirname(located.path)
      const explicit = typeof args.installRoot === 'string' && args.installRoot.trim().length > 0
        ? resolveUserPath(args.installRoot, exec)
        : null
      const selected = await selectInstallRoot({
        candidates: candidateInstallRoots({ projectDir: invocation.projectDir, manifestRoot }),
        explicit,
      })

      let reconciliation = null
      let statusPath = null
      const warnings = [...invocation.warnings]
      if (selected.installRoot !== null) {
        const read = await readInstalledPackages(selected.installRoot)
        if (read.ok) {
          statusPath = read.path
          reconciliation = reconcile(manifest, read.packages)
        } else {
          warnings.push(read.error)
        }
      }

      return {
        manifestPath: located.path,
        foundBy: located.foundBy,
        manifestRoot,
        manifest: {
          path: manifest.path,
          name: manifest.name,
          version: manifest.version,
          versionKey: manifest.versionKey,
          description: manifest.description,
          builtinBaseline: manifest.builtinBaseline,
          dependencies: manifest.dependencies,
          overrides: manifest.overrides,
          features: manifest.features,
          vcpkgConfiguration: manifest.vcpkgConfiguration,
          unknownKeys: manifest.unknownKeys,
        },
        installRoot: selected.installRoot,
        statusPath,
        checked: selected.checked,
        triplet: invocation.environment.triplet,
        reconciliation,
        warnings,
      }
    },
    timeoutMs: 60_000,
  })
}
