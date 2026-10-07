/**
 * A background job producer for one vcpkg run.
 *
 * The 0.2.0 job runtime gives each job one output ring. A producer either names
 * pull sources on the spec or pushes through the job handle, and the ring is
 * what `job_output` reads. `JobOutcome.result` is rendered after the ring
 * contents, so putting the same bytes there would show the log twice.
 *
 * This producer pushes and reports only the exit status. Retention, lossy reads
 * and the model's reading cursor all belong to the registry's ring.
 *
 * @module dsh-vcpkg/core/stream
 */

import { spawn } from 'node:child_process'

import { messageOf } from './runner.js'

/** Grace period between the terminating signal and SIGKILL. */
const KILL_GRACE_MS = 5000

/** Minimum gap between `updateProgress` calls, so a chatty build cannot flood the job. */
const PROGRESS_INTERVAL_MS = 1500

/**
 * Start one vcpkg process as a job producer.
 *
 * `done` never rejects: the runtime converts a rejection into `failed` without
 * keeping the detail, and a build outcome is more useful than a stack.
 * @param {object} options - the invocation.
 * @param {string} options.command - executable path.
 * @param {readonly string[]} options.args - arguments, passed without a shell.
 * @param {string} [options.cwd] - working directory.
 * @param {NodeJS.ProcessEnv} [options.env] - the complete child environment.
 * @param {(text: string) => void} [options.append] - sink for live output.
 * @param {(line: string) => void} [options.progress] - sink for the current phase line.
 * @returns {{ pid: number | undefined, cancel: (reason?: string) => void, done: Promise<{ status: string, detail: string }> }}
 *   the `JobHooks` the registry expects, plus the child's pid.
 */
export function startJobProcess({ command, args, cwd, env, append, progress }) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

  let settled = false
  let cancelled = false
  let lastProgressAt = 0
  /** @type {NodeJS.Timeout | undefined} */
  let killTimer
  /** @type {(outcome: object) => void} */
  let resolveDone
  const done = new Promise((resolve) => {
    resolveDone = resolve
  })

  /**
   * Forward one chunk to the job's ring and refresh the phase line.
   * @param {string} chunk - the decoded chunk.
   * @param {boolean} isError - whether it arrived on stderr.
   * @returns {void}
   */
  function emit(chunk, isError) {
    const text = isError
      ? chunk.split('\n').map((line) => (line.length === 0 ? line : `[stderr] ${line}`)).join('\n')
      : chunk
    try {
      // A disposed job must not take the build down; the process is still ours to reap.
      append?.(text)
    } catch {
      // As above: the ring is the registry's, and losing it is not a build failure.
    }
    const now = Date.now()
    if (now - lastProgressAt < PROGRESS_INTERVAL_MS) return
    const lastLine = text.trimEnd().split('\n').pop()?.trim() ?? ''
    if (lastLine.length === 0) return
    lastProgressAt = now
    try {
      progress?.(lastLine.slice(0, 200))
    } catch {
      // Progress is advisory; losing it never fails the job.
    }
  }

  for (const [stream, isError] of [[child.stdout, false], [child.stderr, true]]) {
    stream.setEncoding('utf8')
    stream.on('data', (chunk) => emit(chunk, isError))
    stream.on('error', () => {})
  }

  child.on('error', (error) => {
    emit(`\n[vcpkg] spawn failed: ${messageOf(error)}\n`, false)
  })

  child.on('close', (code, termSignal) => {
    if (settled) return
    settled = true
    if (killTimer !== undefined) clearTimeout(killTimer)
    const detail = `exit code: ${code ?? 'none'}${termSignal === null ? '' : ` (${termSignal})`}`
    resolveDone({
      status: cancelled ? 'killed' : code === 0 ? 'completed' : 'failed',
      detail: cancelled ? `cancelled; ${detail}` : detail,
    })
  })

  return {
    pid: child.pid,
    cancel(reason) {
      if (settled) return
      cancelled = true
      if (typeof reason === 'string' && reason.length > 0) emit(`\n[vcpkg] cancel requested: ${reason}\n`, false)
      try {
        child.kill('SIGTERM')
      } catch {
        // The process already exited.
      }
      killTimer ??= setTimeout(() => {
        try {
          child.kill('SIGKILL')
        } catch {
          // The process already exited.
        }
      }, KILL_GRACE_MS)
    },
    done,
  }
}
