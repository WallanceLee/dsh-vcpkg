/**
 * Small shared formatting helpers for the tool renderers.
 *
 * @module dsh-vcpkg/tools/common
 */

/** Cap on one rendered tool result, in UTF-8 bytes. */
export const RENDER_LIMIT_BYTES = 24 * 1024

/**
 * Wrap rendered text as model-facing content, trimming it to the render budget
 * so one wide inventory cannot crowd out the rest of the context.
 * @param {string} body - the rendered text.
 * @returns {{ type: 'text', text: string }[]} the content blocks.
 */
export function text(body) {
  if (Buffer.byteLength(body, 'utf8') <= RENDER_LIMIT_BYTES) return [{ type: 'text', text: body }]
  const trimmed = Buffer.from(body, 'utf8').subarray(0, RENDER_LIMIT_BYTES).toString('utf8')
  return [{ type: 'text', text: `${trimmed}\n… result truncated at ${RENDER_LIMIT_BYTES} bytes; narrow the query or read the canonical value for the rest.` }]
}

/**
 * Join non-empty lines.
 * @param {(string | null | undefined | false)[]} lines - the candidate lines.
 * @returns {string} the joined text.
 */
export function lines(...candidates) {
  return candidates.flat().filter((line) => typeof line === 'string' && line.length > 0).join('\n')
}

/**
 * Render a trailing warnings block.
 * @param {string[]} warnings - the warnings.
 * @returns {string} the block, empty when there are none.
 */
export function warningBlock(warnings) {
  if (!Array.isArray(warnings) || warnings.length === 0) return ''
  return warnings.map((warning) => `warning: ${warning}`).join('\n')
}

/**
 * Render one `key: value` line, skipping empty values.
 * @param {string} key - the label.
 * @param {unknown} value - the value.
 * @returns {string} the line, or an empty string.
 */
export function field(key, value) {
  if (value === null || value === undefined || value === '') return ''
  return `${key}: ${value}`
}
