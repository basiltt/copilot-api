import { createHash } from "node:crypto"

import {
  type AnthropicAssistantMessage,
  type AnthropicMessagesPayload,
} from "./anthropic-types"
import { clientTools } from "./client-tools"
import { compileToolSchema, toolInputSchema } from "./tool-input"

const OPENAI_TOOL_NAME_PATTERN = /^[\w-]{1,64}$/
const FALLBACK_TOOL_NAME = "tool"
const HASH_LENGTHS = [8, 12, 16, 20, 24, 28, 32, 40]

export interface ToolNameMap {
  anthropicToOpenAI: Record<string, string>
  openAIToAnthropic: Record<string, string>
  inputSchemas?: Record<string, Record<string, unknown>>
  toolsetToOpenAI?: Map<string, string>
  toolIdentities?: Record<string, { name: string; toolset_name?: string }>
}

export function createToolNameMapFromAnthropicPayload(
  payload: AnthropicMessagesPayload,
): ToolNameMap {
  const names = new Set<string>()
  const scopedNames = new Map<string, { name: string; toolset_name: string }>()
  const tools = clientTools(payload.tools)

  for (const tool of tools) {
    if (tool.toolset_name)
      scopedNames.set(JSON.stringify([tool.toolset_name, tool.name]), {
        name: tool.name,
        toolset_name: tool.toolset_name,
      })
    else names.add(tool.name)
  }

  for (const message of payload.messages) {
    if (message.role !== "assistant") continue
    collectAssistantToolNames(message, names)
    if (!Array.isArray(message.content)) continue
    for (const block of message.content) {
      if (block.type === "tool_use" && block.toolset_name) {
        scopedNames.set(JSON.stringify([block.toolset_name, block.name]), {
          name: block.name,
          toolset_name: block.toolset_name,
        })
      }
    }
  }

  if (payload.tool_choice?.type === "tool" && payload.tool_choice.name) {
    names.add(payload.tool_choice.name)
  }

  const map = createToolNameMap(names)
  map.toolsetToOpenAI = new Map()
  map.toolIdentities = Object.create(null) as NonNullable<
    ToolNameMap["toolIdentities"]
  >
  const used = new Set(Object.keys(map.openAIToAnthropic))
  for (const [key, identity] of scopedNames) {
    const alias = pickOpenAIToolNameAlias(
      `${identity.toolset_name}__${identity.name}`,
      used,
    )
    used.add(alias)
    map.toolsetToOpenAI.set(key, alias)
    map.toolIdentities[alias] = identity
  }
  map.inputSchemas = Object.create(null) as Record<
    string,
    Record<string, unknown>
  >
  for (const tool of tools) {
    const schema = toolInputSchema(tool)
    compileToolSchema(schema)
    map.inputSchemas[toOpenAIToolName(tool.name, map, tool.toolset_name)] =
      schema
  }
  return map
}

export function createToolNameMap(names: Iterable<string>): ToolNameMap {
  const anthropicToOpenAI: Record<string, string> = Object.create(
    null,
  ) as Record<string, string>
  const openAIToAnthropic: Record<string, string> = Object.create(
    null,
  ) as Record<string, string>
  const usedAliases = new Set<string>()

  for (const name of new Set(names)) {
    const alias = pickOpenAIToolNameAlias(name, usedAliases)
    anthropicToOpenAI[name] = alias
    openAIToAnthropic[alias] = name
    usedAliases.add(alias)
  }

  return { anthropicToOpenAI, openAIToAnthropic }
}

export function toOpenAIToolName(
  anthropicName: string,
  toolNameMap: ToolNameMap | undefined,
  toolsetName?: string,
): string {
  if (toolsetName) {
    return (
      toolNameMap?.toolsetToOpenAI?.get(
        JSON.stringify([toolsetName, anthropicName]),
      ) ?? `${toolsetName}__${anthropicName}`
    )
  }
  return toolNameMap?.anthropicToOpenAI[anthropicName] ?? anthropicName
}

export function toAnthropicToolIdentity(
  name: string,
  map?: ToolNameMap,
): { name: string; toolset_name?: string } {
  return map?.toolIdentities?.[name] ?? { name: toAnthropicToolName(name, map) }
}

export function toAnthropicToolName(
  openAIName: string,
  toolNameMap: ToolNameMap | undefined,
): string {
  return toolNameMap?.openAIToAnthropic[openAIName] ?? openAIName
}

function collectAssistantToolNames(
  message: AnthropicAssistantMessage,
  names: Set<string>,
) {
  if (!Array.isArray(message.content)) {
    return
  }

  for (const block of message.content) {
    if (block.type === "tool_use" && !block.toolset_name) {
      names.add(block.name)
    }
  }
}

function pickOpenAIToolNameAlias(
  name: string,
  usedAliases: Set<string>,
): string {
  if (OPENAI_TOOL_NAME_PATTERN.test(name) && !usedAliases.has(name)) {
    return name
  }

  const sanitizedName = sanitizeToolName(name)
  if (
    OPENAI_TOOL_NAME_PATTERN.test(sanitizedName)
    && !usedAliases.has(sanitizedName)
  ) {
    return sanitizedName
  }

  for (const [attempt, HASH_LENGTH] of HASH_LENGTHS.entries()) {
    const hashInput = attempt === 0 ? name : `${name}:${attempt}`
    const hash = hashToolName(hashInput).slice(0, HASH_LENGTH)
    const alias = buildHashedAlias(sanitizedName, hash)
    if (!usedAliases.has(alias)) {
      return alias
    }
  }

  return buildHashedAlias(FALLBACK_TOOL_NAME, hashToolName(name).slice(0, 40))
}

function sanitizeToolName(name: string): string {
  const sanitized = name.replaceAll(/[^\w-]/g, "_").replaceAll(/^_+|_+$/g, "")
  return sanitized || FALLBACK_TOOL_NAME
}

function buildHashedAlias(baseName: string, hash: string): string {
  const separator = "__"
  const maxBaseLength = 64 - separator.length - hash.length
  if (maxBaseLength <= 0) {
    return hash.slice(0, 64)
  }

  const compactBase =
    baseName.length <= maxBaseLength ?
      baseName
    : compactToolNameBase(baseName, maxBaseLength)

  return `${compactBase}${separator}${hash}`
}

function compactToolNameBase(baseName: string, maxLength: number): string {
  const prefixLength = Math.ceil(maxLength / 2)
  const suffixLength = Math.floor(maxLength / 2)
  return baseName.slice(0, prefixLength) + baseName.slice(-suffixLength)
}

function hashToolName(name: string): string {
  return createHash("sha1").update(name).digest("hex")
}
