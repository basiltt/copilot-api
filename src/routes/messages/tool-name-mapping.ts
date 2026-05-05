import { createHash } from "node:crypto"

import {
  type AnthropicAssistantMessage,
  type AnthropicMessagesPayload,
  isTypedTool,
} from "./anthropic-types"

const OPENAI_TOOL_NAME_PATTERN = /^[\w-]{1,64}$/
const FALLBACK_TOOL_NAME = "tool"
const HASH_LENGTHS = [8, 12, 16, 20, 24, 28, 32, 40]

export interface ToolNameMap {
  anthropicToOpenAI: Record<string, string>
  openAIToAnthropic: Record<string, string>
}

export function createToolNameMapFromAnthropicPayload(
  payload: AnthropicMessagesPayload,
): ToolNameMap {
  const names = new Set<string>()

  for (const tool of payload.tools ?? []) {
    if (!isTypedTool(tool)) {
      names.add(tool.name)
    }
  }

  for (const message of payload.messages) {
    if (message.role === "assistant") {
      collectAssistantToolNames(message, names)
    }
  }

  if (payload.tool_choice?.type === "tool" && payload.tool_choice.name) {
    names.add(payload.tool_choice.name)
  }

  return createToolNameMap(names)
}

export function createToolNameMap(names: Iterable<string>): ToolNameMap {
  const anthropicToOpenAI: Record<string, string> = {}
  const openAIToAnthropic: Record<string, string> = {}
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
): string {
  return toolNameMap?.anthropicToOpenAI[anthropicName] ?? anthropicName
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
    if (block.type === "tool_use") {
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
