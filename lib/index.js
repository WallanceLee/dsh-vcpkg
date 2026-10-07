/**
 * dsh-vcpkg — a vcpkg toolset for DeepSeek Harness.
 *
 * Six model-facing tools over one shared preflight. Every tool resolves the
 * workspace, the vcpkg tree, and the network before it does anything else, so
 * the proxy that unblocks a registry download is in place before the first
 * `vcpkg` process exists. Nothing in this plugin mutates the Harness process
 * environment: resolution is per invocation.
 *
 * Function-plugin shape throughout: named exports of `name` / `inject` /
 * `Config` / `apply` and no default export, so the Loader keeps the injection
 * metadata.
 *
 * @module dsh-vcpkg
 */

import z from '@deepseek-ai/schemastery'

import { vcpkgInfoTool } from './tools/info.js'
import { vcpkgInstallTool } from './tools/install.js'
import { vcpkgListTool } from './tools/list.js'
import { vcpkgManifestTool } from './tools/manifest.js'
import { vcpkgProxyTool } from './tools/proxy.js'
import { vcpkgSearchTool } from './tools/search.js'

/** Loader-facing plugin name. */
export const name = 'dsh-vcpkg'

/** This plugin contributes tools and nothing else. */
export const inject = ['tools']

/** Deployment configuration; every field has a working default. */
export const Config = z.object({
  /** Pin the vcpkg tree this deployment uses, ahead of `VCPKG_ROOT`. */
  vcpkgRoot: z.string(),
  /** Pin the triplet, behind `VCPKG_DEFAULT_TRIPLET` and an explicit argument. */
  triplet: z.string(),
  /** Pin a proxy URL ahead of the environment and automatic detection. */
  proxy: z.string(),
  /** Extra comma-separated `NO_PROXY` hosts. Loopback is always kept direct. */
  noProxy: z.string(),
  /** Extra proxy URLs to probe before the built-in list. */
  proxyCandidates: z.array(z.string()),
  /** Probe well-known local proxy ports when nothing else is configured. Defaults to true. */
  autoDetectProxy: z.boolean().default(true),
  /** Expose `runInBackground` on vcpkg_install. Defaults to true. */
  enableBackgroundInstall: z.boolean().default(true),
})

/**
 * Register the toolset.
 * @param {object} ctx - the Cordis context.
 * @param {object} [config] - the validated deployment configuration.
 * @returns {void}
 */
export function apply(ctx, config = {}) {
  const resolved = {
    vcpkgRoot: config.vcpkgRoot,
    triplet: config.triplet,
    proxy: config.proxy,
    noProxy: config.noProxy,
    proxyCandidates: config.proxyCandidates,
    autoDetectProxy: config.autoDetectProxy !== false,
    enableBackgroundInstall: config.enableBackgroundInstall !== false,
  }
  // Registration is effect-based: disposing this plugin's fiber unregisters
  // every tool below, which is what makes the vendored HMR path work.
  ctx.tools.register(vcpkgInfoTool({ config: resolved }))
  ctx.tools.register(vcpkgManifestTool({ config: resolved }))
  ctx.tools.register(vcpkgListTool({ config: resolved }))
  ctx.tools.register(vcpkgSearchTool({ config: resolved }))
  ctx.tools.register(vcpkgProxyTool({ config: resolved }))
  ctx.tools.register(vcpkgInstallTool({ config: resolved, ctx }))
}
