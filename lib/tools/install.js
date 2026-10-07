/**
 * `vcpkg_install` — populate an install root, in the foreground or as a job.
 *
 * @module dsh-vcpkg/tools/install
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { join } from 'node:path'

import { isFile, resolveUserPath } from '../core/environment.js'
import { networkHint, prepareInvocation } from '../core/invocation.js'
import { looksLikeNetworkFailure } from '../core/proxy.js'
import { runProcess } from '../core/runner.js'
import { startJobProcess } from '../core/stream.js'
import { field, lines, text, warningBlock } from './common.js'

/** Line budgets for the retained stream excerpts. */
const TAIL_LINES = 60
const HEAD_LINES = 80

const DESCRIPTION = [
  'Run `vcpkg install` for a manifest, so the ports declared in vcpkg.json become available to the C++ build.',
  'This is how a missing dependency named by vcpkg_manifest gets resolved.',
  '',
  'A real install compiles ports and commonly takes tens of minutes, so pass `runInBackground: true` for anything',
  'beyond a trivial tree. A background call returns a job id immediately; collect its progress with job_output and',
  'stop it with job_kill. A foreground call blocks until vcpkg exits and is meant for small or already-built trees.',
  '',
  'Use `dryRun: true` first to see what vcpkg would build without building it. The binary cache means a dry run and',
  'the install that follows it agree on the plan.',
  '',
  'The call routes through the same resolved proxy as every other vcpkg tool, and reports which proxy it used.',
].join(' ')

/**
 * Keep the last `TAIL_LINES` lines of one stream.
 * @param {string} value - the captured stream.
 * @returns {string} the tail.
 */
function tail(value) {
  const trimmed = value.trim()
  if (trimmed.length === 0) return ''
  const all = trimmed.split('\n')
  return all.length <= TAIL_LINES ? trimmed : `… ${all.length - TAIL_LINES} earlier lines omitted\n${all.slice(-TAIL_LINES).join('\n')}`
}

/**
 * Keep the first `HEAD_LINES` lines of one stream. A dry run's product is its
 * plan, and the plan opens with the compiler hash and the list of ports vcpkg
 * would build — the part a tail would cut off.
 * @param {string} value - the captured stream.
 * @returns {string} the head.
 */
function head(value) {
  const trimmed = value.trim()
  if (trimmed.length === 0) return ''
  const all = trimmed.split('\n')
  return all.length <= HEAD_LINES ? trimmed : `${all.slice(0, HEAD_LINES).join('\n')}\n… ${all.length - HEAD_LINES} later lines omitted`
}

/**
 * Render the install result.
 * @param {object} value - the canonical value.
 * @returns {{ type: 'text', text: string }[]} the content blocks.
 */
function render(value) {
  if (value.mode === 'background') {
    return text(lines(
      `started background vcpkg install: ${value.jobId}`,
      `  command: ${value.commandLine}`,
      field('  manifest root', value.manifestRoot),
      field('  install root', value.installRoot),
      field('  triplet', value.triplet),
      `  network: ${value.proxy.url ?? 'direct connection'}`,
      `Collect progress with job_output "${value.jobId}"; stop it with job_kill "${value.jobId}".`,
      'A full vcpkg install can take tens of minutes. When it settles, run vcpkg_list to confirm the ports landed.',
      warningBlock(value.warnings),
    ))
  }
  const ok = value.exitCode === 0
  const body = [
    `${value.dryRun ? 'dry run of vcpkg install' : 'vcpkg install'} ${ok ? 'succeeded' : `FAILED (exit code ${value.exitCode ?? 'none'})`}`,
    `  command: ${value.commandLine}`,
    field('  manifest root', value.manifestRoot),
    field('  install root', value.installRoot),
    field('  triplet', value.triplet),
    field('  duration', `${(value.durationMs / 1000).toFixed(1)} s`),
    `  network: ${value.proxy.url ?? 'direct connection'} (${value.proxy.source})`,
    value.timedOut ? '  the call hit its deadline and vcpkg was terminated' : null,
    value.truncated ? '  output was truncated; only an excerpt is shown' : null,
    value.dryRun && ok ? `\nplan:\n${value.stdoutHead}` : null,
    ok ? null : `stderr tail:\n${value.stderrTail}`,
    ok ? null : `stdout tail:\n${value.stdoutTail}`,
    value.networkSuspected ? `\nThis looks like a network failure rather than a build failure. ${networkHint({ proxy: value.proxy })}` : null,
    warningBlock(value.warnings),
  ]
  return text(lines(body))
}

/**
 * Build the tool.
 * @param {object} options - the registration inputs.
 * @param {object} options.config - the plugin Config.
 * @param {object} options.ctx - the plugin context, used to reach the optional job registry.
 * @returns {object} the tool definition.
 */
export function vcpkgInstallTool({ config, ctx }) {
  const backgroundEnabled = config.enableBackgroundInstall !== false
  return defineTool({
    name: 'vcpkg_install',
    description: DESCRIPTION,
    parameters: {
      manifestRoot: {
        type: 'string',
        required: true,
        description: 'Directory containing vcpkg.json. A relative path resolves against the session workspace.',
      },
      triplet: {
        type: 'string',
        description: 'Triplet to build for. Defaults to VCPKG_DEFAULT_TRIPLET, else the host triplet.',
      },
      dryRun: {
        type: 'boolean',
        description: 'Report what would be built without building it. Defaults to false.',
      },
      installRoot: {
        type: 'string',
        description: 'Write the installed tree here instead of vcpkg\'s default `<manifestRoot>/vcpkg_installed`.',
      },
      ...backgroundEnabled
        ? {
          runInBackground: {
            type: 'boolean',
            description: 'Return a job id immediately instead of blocking. Recommended for any real install.',
          },
        }
        : {},
    },
    output: { schema: { type: 'json' }, render: (_args, value) => render(value) },
    async execute(args, exec) {
      const invocation = await prepareInvocation({ exec, config, args, signal: exec.signal })
      const environment = invocation.environment
      if (environment.binary === null || environment.root === null) {
        throw new Error(`${environment.warnings[0] ?? 'no bootstrapped vcpkg tree was found'}; run vcpkg_info to see which roots were examined`)
      }
      if (environment.triplet === null) {
        throw new Error(`${environment.tripletSource}; pass \`triplet\` explicitly`)
      }

      const manifestRoot = resolveUserPath(args.manifestRoot, exec)
      if (!isFile(join(manifestRoot, 'vcpkg.json'))) {
        throw new Error(`no vcpkg.json in ${manifestRoot}; pass \`manifestRoot\` as the directory that holds it`)
      }

      const explicitInstallRoot = typeof args.installRoot === 'string' && args.installRoot.trim().length > 0
        ? resolveUserPath(args.installRoot, exec)
        : null
      const installRoot = explicitInstallRoot ?? join(manifestRoot, 'vcpkg_installed')

      const argv = ['install', `--triplet=${environment.triplet}`, `--x-manifest-root=${manifestRoot}`]
      if (explicitInstallRoot !== null) argv.push(`--x-install-root=${explicitInstallRoot}`)
      if (args.dryRun === true) argv.push('--dry-run')

      const commandLine = `${environment.binary} ${argv.join(' ')}`
      const proxy = {
        url: invocation.proxy.url,
        source: invocation.proxy.source,
        noProxy: invocation.proxy.noProxy,
      }

      if (args.runInBackground === true) {
        const jobs = ctx.get('jobs')
        if (jobs === undefined) {
          throw new Error('background jobs unavailable: load @deepseek-ai/dsh-jobs and @deepseek-ai/dsh-tool-jobs, or call again in the foreground')
        }
        if (exec.signal.aborted) {
          const error = new Error('tool call aborted before the job started')
          error.name = 'AbortError'
          throw error
        }
        const jobId = jobs.start({
          kind: 'vcpkg',
          label: commandLine,
          // The owner is a session id that must resolve to a live agent, not the
          // agent object itself — the registry looks it up to fence and clean up.
          ...exec.agent === undefined ? {} : { owner: exec.agent.id },
          run: (job) => {
            const running = startJobProcess({
              command: environment.binary,
              args: argv,
              cwd: manifestRoot,
              env: invocation.env,
              append: (text) => job.append(text),
              progress: (line) => job.updateProgress(line),
            })
            return { cancel: running.cancel, done: running.done }
          },
        })
        return {
          mode: 'background',
          jobId,
          argv,
          commandLine,
          manifestRoot,
          installRoot,
          triplet: environment.triplet,
          dryRun: args.dryRun === true,
          proxy,
          warnings: invocation.warnings,
        }
      }

      const result = await runProcess({
        command: environment.binary,
        args: argv,
        cwd: manifestRoot,
        env: invocation.env,
        signal: exec.signal,
      })
      if (result.aborted) {
        const error = new Error('tool call aborted; vcpkg was terminated')
        error.name = 'AbortError'
        throw error
      }

      const combined = `${result.stdout}\n${result.stderr}`
      return {
        mode: 'foreground',
        argv,
        commandLine,
        manifestRoot,
        installRoot,
        triplet: environment.triplet,
        dryRun: args.dryRun === true,
        exitCode: result.code,
        durationMs: result.durationMs,
        truncated: result.truncated,
        timedOut: result.timedOut,
        stdoutHead: head(result.stdout),
        stdoutTail: tail(result.stdout),
        stderrTail: tail(result.stderr),
        proxy,
        networkSuspected: result.code !== 0 && looksLikeNetworkFailure(combined),
        warnings: invocation.warnings,
      }
    },
  })
}
