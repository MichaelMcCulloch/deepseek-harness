/**
 * Process-stable symbol keys that name one entity in both the bundled runtime
 * entry and the unbundled `./internal` output.
 *
 * @module @deepseek-ai/dsh-subagent/markers
 */

import type { ToolDefinition } from '@deepseek-ai/dsh-tools'

/** Process-stable identity carried only by the standard adjacent-Agent messaging tool. */
export const adjacentAgentSendMessageTool = Symbol.for('dsh.subagent.adjacentAgentSendMessageTool')

/**
 * Mark the standard adjacent-Agent messaging tool without changing its model-visible schema.
 * @param definition - the standard `send_message` definition.
 * @returns the same definition with its internal identity installed.
 */
export function markAdjacentAgentSendMessageTool(definition: ToolDefinition): ToolDefinition {
  Object.defineProperty(definition, adjacentAgentSendMessageTool, { value: true })
  return definition
}

/**
 * Test whether one visible definition is the standard adjacent-Agent messaging tool.
 * @param definition - the scope-resolved `send_message` candidate.
 * @returns whether the definition carries the internal standard-tool identity.
 */
export function isAdjacentAgentSendMessageTool(definition: ToolDefinition | undefined): boolean {
  return definition !== undefined
    && (definition as ToolDefinition & { [adjacentAgentSendMessageTool]?: true })[adjacentAgentSendMessageTool] === true
}

/**
 * Process-stable symbol-keyed host delivery shared by the bundled runtime
 * entry and this unbundled internal subpath.
 * @internal
 */
export const deliverSubagentPrompt = Symbol.for('dsh.subagent.deliverPrompt')
