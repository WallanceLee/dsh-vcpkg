/**
 * Bounded child-process execution for vcpkg invocations.
 *
 * vcpkg is a long-running native binary. One install can emit megabytes on
 * stderr and take an hour. This module handles three things for its callers:
 * a bounded capture, a cooperative deadline, and cancellation that waits for
 * the child to actually exit.
 *
 * @module dsh-vcpkg/core/runner
 */

import { spawn } from 'node:child_process'

/** Per-stream capture cap in UTF-8 bytes; output beyond it is dropped and reported. */
export const DEFAULT_MAX_OUTPUT_BYTES = 128 * 1024

/** Grace period between the terminating signal and SIGKILL. */
const KILL_GRACE_MS = 5000

/**
 * Truncate a string to at most `limit` UTF-8 bytes. A code point split by the
 * byte boundary becomes U+FFFD rather than invalid text.
 * @param {string} text - the text to truncate.
 * @param {number} limit - maximum UTF-8 byte length.
 * @returns {string} the truncated text.
 */
export function truncateToBytes(text, limit) {
  if (Buffer.byteLength(text, 'utf8') <= limit) return text
  return Buffer.from(text, 'utf8').subarray(0, Math.max(0, limit)).toString('utf8')
}

/**
 * Render an unknown thrown value as one line.
 * @param {unknown} error - the thrown value.
 * @returns {string} a human-readable message.
 */
export function messageOf(error) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * One settled process run.
 * @typedef {object} ProcessOutcome
 * @property {number|null} code - exit code; null when the process never exited normally.
 * @property {string|null} signal - the signal that ended the process, when one did.
 * @property {string} stdout - captured standard output, capped.
 * @property {string} stderr - captured standard error, capped.
 * @property {boolean} truncated - whether either stream hit the cap.
 * @property {boolean} timedOut - whether this call's deadline fired.
 * @property {boolean} aborted - whether the caller's signal fired.
 * @property {string|null} spawnError - the spawn failure, when the process never started.
 * @property {boolean} failed - whether the run should be treated as unsuccessful.
 * @property {number} durationMs - wall-clock duration of the run.
 */

/**
 * Run one process to completion.
 * @param {object} options - the invocation.
 * @param {string} options.command - executable path.
 * @param {readonly string[]} options.args - arguments, passed without a shell.
 * @param {string} [options.cwd] - working directory.
 * @param {NodeJS.ProcessEnv} [options.env] - the complete child environment.
 * @param {AbortSignal} [options.signal] - caller cancellation.
 * @param {number} [options.timeoutMs] - cooperative deadline; omitted means none.
 * @param {number} [options.maxOutputBytes] - per-stream capture cap.
 * @returns {Promise<ProcessOutcome>} the settled outcome; this never rejects.
 */
export function runProcess({ command, args, cwd, env, signal, timeoutMs, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES }) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    /** @type {ProcessOutcome} */
    const outcome = {
      code: null,
      signal: null,
      stdout: '',
      stderr: '',
      truncated: false,
      timedOut: false,
      aborted: false,
      spawnError: null,
      failed: false,
      durationMs: 0,
    }
    let settled = false
    /** @type {import('node:child_process').ChildProcess | undefined} */
    let child
    /** @type {NodeJS.Timeout | undefined} */
    let deadlineTimer
    /** @type {NodeJS.Timeout | undefined} */
    let killTimer

    function settle() {
      if (settled) return
      settled = true
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
      if (killTimer !== undefined) clearTimeout(killTimer)
      signal?.removeEventListener('abort', onAbort)
      outcome.durationMs = Date.now() - startedAt
      outcome.failed = outcome.code !== 0 || outcome.spawnError !== null
      resolve(outcome)
    }

    function terminate() {
      if (child === undefined || child.exitCode !== null || child.signalCode !== null) return
      try {
        child.kill('SIGTERM')
      } catch {
        // The process already exited between the guard and the signal.
      }
      killTimer ??= setTimeout(() => {
        try {
          child?.kill('SIGKILL')
        } catch {
          // The process already exited.
        }
      }, KILL_GRACE_MS)
    }

    function onAbort() {
      outcome.aborted = true
      terminate()
    }

    if (signal?.aborted === true) {
      outcome.aborted = true
      settle()
      return
    }

    try {
      child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    } catch (error) {
      outcome.spawnError = messageOf(error)
      settle()
      return
    }

    for (const [stream, key] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
      stream.setEncoding('utf8')
      stream.on('data', (chunk) => {
        if (outcome.truncated) return
        const next = outcome[key] + chunk
        if (Buffer.byteLength(next, 'utf8') > maxOutputBytes) {
          outcome[key] = truncateToBytes(next, maxOutputBytes)
          outcome.truncated = true
          return
        }
        outcome[key] = next
      })
      // A broken pipe must not fail the run: the outcome still carries the exit code.
      stream.on('error', () => {})
    }

    child.on('error', (error) => {
      outcome.spawnError = messageOf(error)
    })
    child.on('close', (code, termSignal) => {
      outcome.code = code
      outcome.signal = termSignal
      settle()
    })

    if (typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0) {
      deadlineTimer = setTimeout(() => {
        outcome.timedOut = true
        terminate()
      }, timeoutMs)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
