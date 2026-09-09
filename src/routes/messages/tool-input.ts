import Ajv, { type ValidateFunction } from "ajv"
import Ajv2019 from "ajv/dist/2019"
import Ajv2020 from "ajv/dist/2020"

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
  if (schema && !compileToolSchema(schema)(input)) {
    throw invalidToolInput(
      name,
      "arguments do not match the declared input_schema",
    )
  }
  return input as Record<string, unknown>
}

export function invalidToolInput(name: string, reason: string): HTTPError {
  const message = `Invalid upstream tool call "${name}": ${reason}. No tool was executed; retry the request.`
  return new HTTPError(
    message,
    Response.json(
      { type: "error", error: { type: "api_error", message } },
      { status: 502 },
    ),
  )
}
