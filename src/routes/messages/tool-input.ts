import Ajv, { type ErrorObject, type ValidateFunction } from "ajv"
import Ajv2019 from "ajv/dist/2019"
import Ajv2020 from "ajv/dist/2020"
import consola from "consola"

import { HTTPError } from "~/lib/error"

import type { AnthropicCustomTool } from "./anthropic-types"

const options = {
  strict: false,
  validateFormats: false,
  ownProperties: true,
  addUsedSchema: false,
}
const validators = {
  default: new Ajv(options),
  draft2019: new Ajv2019(options),
  draft2020: new Ajv2020(options),
}
const compiled = new WeakMap<Record<string, unknown>, ValidateFunction>()
const WORKFLOW_SELECTORS = ["script", "name", "scriptPath", "runId"]
const DIAGNOSTIC_KEYWORDS = new Set([
  "type",
  "required",
  "additionalProperties",
  "unevaluatedProperties",
  "enum",
  "const",
  "anyOf",
  "oneOf",
  "allOf",
  "not",
  "if",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "minItems",
  "maxItems",
  "uniqueItems",
  "contains",
  "minContains",
  "maxContains",
  "items",
  "additionalItems",
  "minProperties",
  "maxProperties",
  "dependentRequired",
  "dependencies",
  "propertyNames",
  "false schema",
])

export interface ToolValidationDiagnostic {
  keyword: string
  location: string
}

function jsonType(value: unknown): string {
  if (value === null) return "null"
  if (Array.isArray(value)) return "array"
  return typeof value
}

function safeFinishReason(value: string | null): string | null {
  if (value === null) return null
  return ["content_filter", "length", "stop", "tool_calls"].includes(value) ?
      value
    : "unknown"
}

// eslint-disable-next-line complexity -- Fixed fields avoid exposing arbitrary schema or candidate data.
export function logWriteToolSchemaMismatch(
  raw: string,
  schema: Record<string, unknown>,
  finishReason: string | null,
): void {
  let candidate: Record<string, unknown> | undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed))
      candidate = parsed as Record<string, unknown>
  } catch {
    // The fixed metadata below distinguishes malformed/non-object input.
  }
  const properties =
    (
      schema.properties !== null
      && typeof schema.properties === "object"
      && !Array.isArray(schema.properties)
    ) ?
      (schema.properties as Record<string, unknown>)
    : undefined
  const required = Array.isArray(schema.required) ? schema.required : []
  const requiredNames = required.filter(
    (entry): entry is string => typeof entry === "string",
  )
  const presentNames = candidate ? Object.keys(candidate) : []
  const declaredNames = properties ? Object.keys(properties) : []
  consola.warn("Write tool schema mismatch", {
    finishReason: safeFinishReason(finishReason),
    candidateType: candidate ? "object" : "invalid",
    filePathDeclared: Boolean(
      properties && Object.hasOwn(properties, "file_path"),
    ),
    filePathPresent: Boolean(
      candidate && Object.hasOwn(candidate, "file_path"),
    ),
    filePathType:
      candidate && Object.hasOwn(candidate, "file_path") ?
        jsonType(candidate.file_path)
      : "missing",
    contentDeclared: Boolean(
      properties && Object.hasOwn(properties, "content"),
    ),
    contentPresent: Boolean(candidate && Object.hasOwn(candidate, "content")),
    contentType:
      candidate && Object.hasOwn(candidate, "content") ?
        jsonType(candidate.content)
      : "missing",
    declaredCount: declaredNames.length,
    requiredCount: requiredNames.length,
    presentCount: presentNames.length,
    otherDeclaredCount: declaredNames.filter(
      (name) => name !== "file_path" && name !== "content",
    ).length,
    otherPresentCount: presentNames.filter(
      (name) => name !== "file_path" && name !== "content",
    ).length,
    missingRequiredCount:
      candidate ?
        requiredNames.filter((name) => !Object.hasOwn(candidate, name)).length
      : requiredNames.length,
  })
}

function validationDiagnostics(
  errors: Array<ErrorObject> | null | undefined,
): Array<ToolValidationDiagnostic> {
  return (errors ?? []).slice(0, 5).map((error) => {
    // Even JSON Pointer segments can be customer data (map keys, emails).
    // Only disclose bounded depth and a known validator keyword, never params.
    const depth = error.instancePath.split("/").length - 1
    return {
      keyword:
        DIAGNOSTIC_KEYWORDS.has(error.keyword) ? error.keyword : "schema",
      location:
        "$" + "/*".repeat(Math.min(depth, 6)) + (depth > 6 ? "/..." : ""),
    }
  })
}

export class ToolSchemaMismatchError extends HTTPError {
  readonly diagnostics: Array<ToolValidationDiagnostic>
  readonly toolName!: string

  constructor(name: string, errors: Array<ErrorObject> | null | undefined) {
    const diagnostics = validationDiagnostics(errors)
    const detail = diagnostics
      .map(({ keyword, location }) => `${keyword} at ${location}`)
      .join("; ")
    const error = invalidToolInput(
      name,
      `arguments do not match the declared input_schema (${detail || "schema mismatch"}; property names and values redacted)`,
    )
    super(error.message, error.response)
    this.diagnostics = diagnostics
    Object.defineProperty(this, "toolName", {
      enumerable: false,
      value: name,
    })
  }
}

export function toolInputSchema(
  tool: AnthropicCustomTool,
): Record<string, unknown> {
  const schema = tool.input_schema
  if (tool.name !== "Workflow") return schema
  // Older clients omit their runtime cross-field refinement from JSON Schema.
  // Never invent selectors, overwrite a union, or exclude newer runId calls.
  if (schema.anyOf || schema.oneOf || schema.allOf) return schema
  const properties = schema.properties
  if (!properties || typeof properties !== "object") return schema
  const selectors = WORKFLOW_SELECTORS.filter((key) =>
    Object.hasOwn(properties, key),
  )
  const required = schema.required
  if (
    selectors.length === 0
    || (Array.isArray(required)
      && selectors.some((key) => required.includes(key)))
  ) {
    return schema
  }
  return { ...schema, anyOf: selectors.map((key) => ({ required: [key] })) }
}

export function compileToolSchema(
  schema: Record<string, unknown>,
): ValidateFunction {
  const cached = compiled.get(schema)
  if (cached) return cached
  const dialect = schema.$schema
  let validator = validators.default
  if (typeof dialect === "string" && dialect.includes("2020-12"))
    validator = validators.draft2020
  if (typeof dialect === "string" && dialect.includes("2019-09"))
    validator = validators.draft2019
  let validate: ValidateFunction
  try {
    if (schema.$async) throw new Error("Async tool schemas are unsupported")
    validate = validator.compile(schema)
    if ("$async" in validate)
      throw new Error("Async tool validators are unsupported")
    validator.removeSchema(schema)
  } catch {
    validator.removeSchema(schema)
    throw new HTTPError(
      "Invalid tool input schema",
      Response.json(
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            message:
              "A tool input_schema is invalid or uses an unsupported JSON Schema dialect/reference.",
          },
        },
        { status: 400 },
      ),
    )
  }
  compiled.set(schema, validate)
  return validate
}

export function parseToolInput(
  raw: string,
  name: string,
  schema?: Record<string, unknown>,
): Record<string, unknown> {
  let input: unknown
  try {
    input = JSON.parse(raw)
  } catch {
    throw invalidToolInput(
      name,
      "missing, malformed, or truncated JSON arguments",
    )
  }
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw invalidToolInput(name, "arguments must be a JSON object")
  }
  if (schema) {
    const validate = compileToolSchema(schema)
    if (!validate(input))
      throw new ToolSchemaMismatchError(name, validate.errors)
  }
  return input as Record<string, unknown>
}

export function invalidToolInput(name: string, reason: string): HTTPError {
  const safeName = /^[\w-]{1,64}$/.test(name) ? name : "[redacted tool name]"
  const message = `Invalid upstream tool call "${safeName}": ${reason}. No tool was executed; retry the request.`
  return new HTTPError(
    message,
    Response.json(
      { type: "error", error: { type: "api_error", message } },
      { status: 502 },
    ),
  )
}
