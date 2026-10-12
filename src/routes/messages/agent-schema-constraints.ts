import consola from "consola"

import type { NativeMessagesCompatibilityResult } from "~/services/copilot/create-native-messages-completion"
import type { Model } from "~/services/copilot/get-models"

import { state } from "~/lib/state"

import {
  type AnthropicCustomTool,
  type AnthropicMessagesPayload,
  isTypedTool,
} from "./anthropic-types"

export const MAX_AGENT_SCHEMA_BYTES = 16_384
export const MAX_AGENT_SCHEMA_PROPERTIES = 24
export const MAX_AGENT_ENUM_VALUES = 32

const ROOT_KEYS = new Set([
  "$schema",
  "title",
  "description",
  "type",
  "properties",
  "required",
  "additionalProperties",
])
const SCALAR_KEYS = new Set([
  "type",
  "title",
  "description",
  "enum",
  "const",
  "default",
])

type SkipReason =
  | "native_unavailable"
  | "catalog_not_advertised"
  | "ambiguous_agent_declaration"
  | "strict_budget_in_use"
  | "schema_unsupported"

function agentTools(
  payload: AnthropicMessagesPayload,
): Array<AnthropicCustomTool> {
  return (
    payload.tools?.filter(
      (tool): tool is AnthropicCustomTool =>
        !isTypedTool(tool) && tool.name === "Agent",
    ) ?? []
  )
}

export function usesAgentSchemaConstraints(
  payload: AnthropicMessagesPayload,
): boolean {
  return (
    state.agentSchemaConstraints === true
    && payload.tool_choice?.type !== "none"
    && (payload.tool_choice?.type !== "tool"
      || payload.tool_choice.name === "Agent")
    && agentTools(payload).some((tool) => !Object.hasOwn(tool, "strict"))
  )
}

export function logSkippedAgentSchemaConstraints(
  reason: SkipReason,
  compatibility?: NativeMessagesCompatibilityResult,
): void {
  consola.warn("Agent schema constraints not applied", {
    reason,
    ...(compatibility ?
      {
        nativeRouting: compatibility.routing,
        nativeRejectionReasons: compatibility.rejectionReasons,
      }
    : {}),
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function matchesScalarType(type: unknown, value: unknown): boolean {
  switch (type) {
    case "string":
    case "boolean": {
      return typeof value === type
    }
    case "number": {
      return typeof value === "number" && Number.isFinite(value)
    }
    case "integer": {
      return typeof value === "number" && Number.isSafeInteger(value)
    }
    case "null": {
      return value === null
    }
    default: {
      return false
    }
  }
}

function matchesScalarConstraints(
  schema: Record<string, unknown>,
  value: unknown,
): boolean {
  return (
    matchesScalarType(schema.type, value)
    && (!Array.isArray(schema.enum) || schema.enum.includes(value))
    && (!Object.hasOwn(schema, "const") || schema.const === value)
  )
}

function supportedScalar(value: unknown): boolean {
  if (
    !isRecord(value)
    || !Object.keys(value).every((key) => SCALAR_KEYS.has(key))
  )
    return false
  if (
    typeof value.type !== "string"
    || !["boolean", "integer", "null", "number", "string"].includes(value.type)
  )
    return false
  const values = value.enum
  if (
    values !== undefined
    && (!Array.isArray(values)
      || values.length === 0
      || values.length > MAX_AGENT_ENUM_VALUES
      || !values.every((entry) => matchesScalarType(value.type, entry)))
  )
    return false
  return ["const", "default"].every(
    (key) =>
      !Object.hasOwn(value, key) || matchesScalarConstraints(value, value[key]),
  )
}

function supportedSchema(schema: unknown): boolean {
  if (
    !isRecord(schema)
    || schema.type !== "object"
    || schema.additionalProperties !== false
    || !Object.keys(schema).every((key) => ROOT_KEYS.has(key))
    || !isRecord(schema.properties)
  )
    return false
  const properties = schema.properties
  const names = Object.keys(properties)
  const required = schema.required === undefined ? [] : schema.required
  if (
    names.length > MAX_AGENT_SCHEMA_PROPERTIES
    || !Array.isArray(required)
    || !required.every(
      (name) => typeof name === "string" && Object.hasOwn(properties, name),
    )
    || new Set(required).size !== required.length
    || !Object.values(properties).every((property) => supportedScalar(property))
  )
    return false
  return (
    Buffer.byteLength(JSON.stringify(schema), "utf8") <= MAX_AGENT_SCHEMA_BYTES
  )
}

function supportsNativeConstraints(
  model:
    | {
        vendor?: unknown
        supported_endpoints?: unknown
        capabilities?: { supports?: { structured_outputs?: unknown } }
      }
    | undefined,
): boolean {
  return (
    typeof model?.vendor === "string"
    && model.vendor.toLowerCase() === "anthropic"
    && Array.isArray(model.supported_endpoints)
    && model.supported_endpoints.includes("/v1/messages")
    && model.capabilities?.supports?.structured_outputs === true
  )
}

export function applyNativeAgentSchemaConstraints(
  payload: AnthropicMessagesPayload,
  model: Model | undefined,
): AnthropicMessagesPayload {
  if (!usesAgentSchemaConstraints(payload)) return payload
  let reason: SkipReason | undefined
  const declarations = agentTools(payload)
  if (!supportsNativeConstraints(model)) reason = "catalog_not_advertised"
  else if (declarations.length !== 1) reason = "ambiguous_agent_declaration"
  else if (
    payload.output_config?.format
    || payload.tools?.some((tool) => !isTypedTool(tool) && tool.strict === true)
  )
    reason = "strict_budget_in_use"
  else if (!supportedSchema(declarations[0].input_schema))
    reason = "schema_unsupported"
  if (reason) {
    logSkippedAgentSchemaConstraints(reason)
    return payload
  }
  const agent = declarations[0]
  return {
    ...payload,
    tools: payload.tools?.map((tool) =>
      tool === agent ? { ...agent, strict: true } : tool,
    ),
  }
}
