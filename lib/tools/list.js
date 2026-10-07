/**
 * `vcpkg_list` — what is actually installed for this project.
 *
 * @module dsh-vcpkg/tools/list
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

import { prepareInvocation } from '../core/invocation.js'
import { resolveUserPath } from '../core/environment.js'
import { candidateInstallRoots, readInstalledPackages, selectInstallRoot } from '../core/status-db.js'
import { dirname } from 'node:path'
import { field, lines, text, warningBlock } from './common.js'

const DESCRIPTION = [
  'List the ports installed in this project\'s vcpkg install root, read from the installed-package database',
  '(`vcpkg_installed/vcpkg/status`). Reports each package with its version and the features it was built with.',
  '',
  'Use it to check whether a dependency is already present before installing, to see which features a port was',
  'built with, and to confirm that an install actually landed. It reads files only; it never runs vcpkg and',
  'never touches the network, so it works even when the vcpkg tree or the proxy is broken.',
  '',
  'Set `verbose` to also get each package\'s ABI hash, description, and dependency list — the ABI hash is what',
  'vcpkg keys its binary cache on, so it is the field to compare when a rebuild unexpectedly recompiles everything.',
].join(' ')

/**
 * Render the inventory.
 * @param {object} value - the canonical value.
 * @returns {{ type: 'text', text: string }[]} the content blocks.
 */
function render(value) {
  if (value.installRoot === null) {
    return text(lines(
      'No vcpkg install root found for this workspace.',
      'these locations were checked:',
      ...value.checked.map((entry) => `  --  ${entry.path}`),
      'Run vcpkg_manifest to see what the manifest declares, then vcpkg_install to populate an install root.',
      warningBlock(value.warnings),
    ))
  }
  const body = [
    `install root: ${value.installRoot}`,
    field('  database', value.statusPath),
    field('  triplet', value.triplet),
    field('  filter', value.filter === null ? null : `${value.filter} (matched ${value.packages.length} of ${value.total})`),
    `${value.packages.length === 0 ? 'no' : value.packages.length} package${value.packages.length === 1 ? '' : 's'}${value.total === value.packages.length ? '' : ` of ${value.total}`}:`,
    ...value.packages.map((entry) => {
      const features = entry.features.length === 0 ? '' : ` [${entry.features.join(', ')}]`
      const abi = entry.abi === null || entry.abi === undefined ? '' : `\n      abi ${entry.abi}`
      const description = entry.description === null || entry.description === undefined ? '' : `\n      ${entry.description}`
      const depends = entry.depends === undefined || entry.depends.length === 0 ? '' : `\n      depends on ${entry.depends.join(', ')}`
      const defaults = entry.defaultFeatures === undefined || entry.defaultFeatures.length === 0
        ? ''
        : `\n      default features not enabled: ${entry.defaultFeatures.filter((feature) => !entry.features.includes(feature)).join(', ') || 'none'}`
      const featureNotes = entry.featureDescriptions === undefined
        ? ''
        : Object.entries(entry.featureDescriptions).map(([feature, note]) => `\n      ${feature}: ${note}`).join('')
      return `  ${entry.name} ${entry.version}${features}${abi}${description}${depends}${defaults}${featureNotes}`
    }),
    warningBlock(value.warnings),
  ]
  return text(lines(body))
}

/**
 * Build the tool.
 * @param {object} options - the registration inputs.
 * @param {object} options.config - the plugin Config.
 * @returns {object} the tool definition.
 */
export function vcpkgListTool({ config }) {
  return defineTool({
    name: 'vcpkg_list',
    description: DESCRIPTION,
    parameters: {
      projectDir: {
        type: 'string',
        description: 'Directory to search for an install root from. Defaults to the session workspace.',
      },
      installRoot: {
        type: 'string',
        description: 'Read exactly this `vcpkg_installed` directory instead of searching for one.',
      },
      filter: {
        type: 'string',
        description: 'Case-insensitive substring; only packages whose name contains it are returned.',
      },
      verbose: {
        type: 'boolean',
        description: 'Also return each package\'s ABI hash, description, and dependencies. Defaults to false.',
      },
      triplet: {
        type: 'string',
        description: 'Triplet to report alongside the inventory. Defaults to the host triplet.',
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
      const manifestRoot = invocation.manifest === null ? null : dirname(invocation.manifest.path)
      const candidates = candidateInstallRoots({ projectDir: invocation.projectDir, manifestRoot })
      const explicit = typeof args.installRoot === 'string' && args.installRoot.trim().length > 0
        ? resolveUserPath(args.installRoot, exec)
        : null
      const selected = await selectInstallRoot({ candidates, explicit })

      if (selected.installRoot === null) {
        return {
          installRoot: null,
          statusPath: null,
          triplet: invocation.environment.triplet,
          filter: null,
          total: 0,
          packages: [],
          checked: selected.checked,
          warnings: invocation.warnings,
        }
      }

      const read = await readInstalledPackages(selected.installRoot)
      if (!read.ok) {
        return {
          installRoot: selected.installRoot,
          statusPath: read.path,
          triplet: invocation.environment.triplet,
          filter: null,
          total: 0,
          packages: [],
          checked: selected.checked,
          warnings: [...invocation.warnings, read.error],
        }
      }

      const filter = typeof args.filter === 'string' && args.filter.trim().length > 0 ? args.filter.trim().toLowerCase() : null
      const matching = filter === null ? read.packages : read.packages.filter((entry) => entry.name.toLowerCase().includes(filter))
      const verbose = args.verbose === true

      return {
        installRoot: selected.installRoot,
        statusPath: read.path,
        triplet: invocation.environment.triplet,
        filter,
        total: read.packages.length,
        packages: matching.map((entry) => (verbose
          ? {
            name: entry.name,
            version: entry.version,
            architecture: entry.architecture,
            abi: entry.abi,
            features: entry.features,
            featureDescriptions: entry.featureDescriptions,
            defaultFeatures: entry.defaultFeatures,
            description: entry.description,
            depends: entry.depends,
          }
          : {
            name: entry.name,
            version: entry.version,
            architecture: entry.architecture,
            features: entry.features,
          })),
        checked: selected.checked,
        warnings: invocation.warnings,
      }
    },
    timeoutMs: 60_000,
  })
}
