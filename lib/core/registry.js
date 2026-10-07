/**
 * Parsers for vcpkg's human-oriented command output.
 *
 * vcpkg has no machine-readable form for these commands, so the parsers live
 * in the peer-free core rather than inside the tool wrappers that call them.
 * That keeps them directly testable and keeps the tool layer to registration
 * and orchestration.
 *
 * @module dsh-vcpkg/core/registry
 */

/** Trailing notices `vcpkg search` appends after the results; they are not results. */
const SEARCH_TRAILING_NOTICE = /^(The result may be outdated|If your port is not listed|Error:|warning:)/i

/**
 * One `vcpkg search` result line:
 *
 *     draco                    1.5.7#1          A library for compressing …
 *     pdal[draco]                               Build the Draco plugin
 *
 * The name is optionally suffixed with `[feature]`; a port row carries a
 * version column and a feature row does not.
 */
const SEARCH_LINE = /^(?<name>[A-Za-z0-9][A-Za-z0-9._-]*)(?:\[(?<feature>[^\]]+)\])?\s{2,}(?<rest>.+)$/

/**
 * Parse `vcpkg search` output into ports and port features.
 * @param {string} output - standard output from `vcpkg search`.
 * @returns {{ ports: { name: string, version: string | null, description: string }[], features: { port: string, feature: string, description: string }[] }}
 *   the parsed results.
 */
export function parseSearchOutput(output) {
  const ports = []
  const features = []
  for (const rawLine of output.split('\n')) {
    const line = rawLine.replace(/\s+$/, '')
    if (line.trim().length === 0) continue
    if (SEARCH_TRAILING_NOTICE.test(line.trim())) continue
    const match = SEARCH_LINE.exec(line)
    if (match === null) continue
    const rest = match.groups.rest.trim()
    if (match.groups.feature !== undefined) {
      features.push({ port: match.groups.name, feature: match.groups.feature, description: rest })
      continue
    }
    const columns = rest.split(/\s{2,}/)
    if (columns.length >= 2 && /^[0-9]/.test(columns[0])) {
      ports.push({ name: match.groups.name, version: columns[0].trim(), description: columns.slice(1).join(' ').trim() })
    } else {
      ports.push({ name: match.groups.name, version: null, description: rest })
    }
  }
  return { ports, features }
}
