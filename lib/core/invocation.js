/**
 * The preflight every vcpkg tool runs before it starts vcpkg.
 *
 * The order matters. The network is resolved before the child environment is
 * built, because vcpkg's first registry fetch happens inside the process about
 * to be spawned; resolving afterwards would be too late. `prepareInvocation` is
 * therefore the first statement of every tool body, so the proxy is applied to
 * every vcpkg call whether or not the model asked about it.
 *
 * Nothing here mutates `process.env`. The resolved variables live only in the
 * environment handed to the child, so a wrong guess costs one call rather than
 * the rest of the session.
 *
 * @module dsh-vcpkg/core/invocation
 */

import { findManifestFile, isCommitReachable, resolveEnvironment, resolveProjectDir } from './environment.js'
import { describeProxy, proxyEnvFor, resolveProxy } from './proxy.js'
import { readManifest } from './manifest.js'
import { readSettings } from './settings.js'

/**
 * Locate and summarize the manifest near a workspace.
 * @param {object} options - the lookup.
 * @param {string} options.projectDir - the anchor directory.
 * @param {unknown} [options.explicitPath] - a manifest path or directory the caller named.
 * @param {string | null} options.root - the resolved vcpkg tree.
 * @param {boolean} options.checkBaseline - whether to ask git about the baseline commit.
 * @param {AbortSignal} [options.signal] - caller cancellation.
 * @returns {Promise<object | null>} the summary, or null when no manifest exists.
 */
async function resolveManifest({ projectDir, explicitPath, root, checkBaseline, signal }) {
  const located = findManifestFile({ startDir: projectDir, explicitPath })
  if (located === null) return null
  const read = await readManifest(located.path)
  if (!read.ok) {
    return { path: located.path, foundBy: located.foundBy, error: read.error, manifest: null, baselineReachable: null }
  }
  let baselineReachable = null
  if (checkBaseline && root !== null && read.manifest.builtinBaseline !== null) {
    baselineReachable = await isCommitReachable({ root, commit: read.manifest.builtinBaseline, signal })
  }
  return {
    path: located.path,
    foundBy: located.foundBy,
    error: null,
    manifest: read.manifest,
    baselineReachable,
  }
}

/**
 * Resolve the workspace, the vcpkg tree, and the network for one tool call.
 * @param {object} options - the call.
 * @param {object} options.exec - the tool run context (session workspace, signal).
 * @param {object} [options.config] - the plugin Config.
 * @param {object} [options.args] - the validated tool arguments.
 * @param {AbortSignal} [options.signal] - caller cancellation.
 * @param {boolean} [options.includeManifest] - whether to locate and summarize `vcpkg.json`.
 * @param {boolean} [options.checkBaseline] - whether to test the baseline commit against the tree.
 * @returns {Promise<object>} everything the tool body needs, plus the warnings
 *   that must not be swallowed.
 */
export async function prepareInvocation({
  exec,
  config = {},
  args = {},
  signal,
  includeManifest = false,
  checkBaseline = false,
}) {
  const settingsRead = await readSettings()
  const settings = settingsRead.values
  const projectDir = resolveProjectDir(args.projectDir, exec)

  const environment = await resolveEnvironment({
    projectDir,
    config,
    settings,
    signal,
    triplet: args.triplet,
  })

  const proxy = await resolveProxy({ config, settings, signal })
  const env = proxyEnvFor(proxy, process.env)

  const manifest = includeManifest
    ? await resolveManifest({
      projectDir,
      explicitPath: args.manifestPath,
      root: environment.root,
      checkBaseline,
      signal,
    })
    : null

  const warnings = []
  if (settingsRead.warning !== undefined) warnings.push(settingsRead.warning)
  warnings.push(...environment.warnings, ...proxy.warnings)
  if (manifest?.error !== null && manifest?.error !== undefined) warnings.push(manifest.error)

  return {
    projectDir,
    settings,
    settingsPath: settingsRead.path,
    settingsExists: settingsRead.exists,
    environment: { ...environment, manifest },
    manifest,
    proxy,
    env,
    warnings,
  }
}

/**
 * One line stating the network path this call will take, so a result never
 * leaves the reader guessing whether a proxy was in play.
 * @param {object} invocation - a {@link prepareInvocation} result.
 * @returns {string} the summary.
 */
export function networkSummary(invocation) {
  return `network: ${describeProxy(invocation.proxy)}`
}

/**
 * Extra guidance attached to a failed network operation.
 * @param {object} invocation - a {@link prepareInvocation} result.
 * @returns {string} the hint.
 */
export function networkHint(invocation) {
  if (invocation.proxy.url !== null) {
    return `This call used the proxy ${invocation.proxy.url}. If the download still failed, run vcpkg_proxy with action "probe" to test that proxy end to end, or pin a different one with action "set".`
  }
  return 'No proxy was configured or detected for this call. Run vcpkg_proxy with action "probe" to test direct connectivity and every known local proxy port, then pin a working one with action "set".'
}
