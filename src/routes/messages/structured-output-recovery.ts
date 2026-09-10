import consola from "consola"

import type {
  ChatCompletionResponse,
  ToolCall,
} from "~/services/copilot/create-chat-completions"

import { HTTPError } from "~/lib/error"
import { state } from "~/lib/state"
import { hasNativeMessagesThinking } from "~/services/copilot/create-native-messages-completion"

import {
  type AnthropicMessagesPayload,
  type AnthropicResponse,
  isTypedTool,
} from "./anthropic-types"
import { translateToAnthropic } from "./non-stream-translation"
import { parseToolInput, ToolSchemaMismatchError } from "./tool-input"
import {
  createToolNameMapFromAnthropicPayload,
  type ToolNameMap,
  toOpenAIToolName,
} from "./tool-name-mapping"

export const STRUCTURED_OUTPUT_RECOVERY_TIMEOUT_MS = 20_000

export type OutputCompletion = (
  payload: AnthropicMessagesPayload,
  signal: AbortSignal,
) => Promise<ChatCompletionResponse>

interface RecoveryOptions {
  map: ToolNameMap
  signal: AbortSignal
  complete: OutputCompletion
}

interface RecoveryContext extends RecoveryOptions {
  payload: AnthropicMessagesPayload
  response: ChatCompletionResponse
}

export function usesStructuredOutputRecovery(
  payload: AnthropicMessagesPayload,
): boolean {
  return (
    state.structuredOutputRecovery === true
    && payload.tool_choice?.type !== "none"
    && (payload.tool_choice?.type !== "tool"
      || payload.tool_choice.name === "StructuredOutput")
    && !payload.output_config?.format
    && !payload.tools?.some((tool) => isTypedTool(tool))
    && Boolean(
      payload.tools?.some(
        (tool) => !isTypedTool(tool) && tool.name === "StructuredOutput",
      ),
    )
  )
}

function soleOutputCall(
  response: ChatCompletionResponse,
  name: string,
): ToolCall | undefined {
  if (response.choices.length !== 1) return undefined
  const choice = response.choices[0]
  if (choice.finish_reason !== "tool_calls" && choice.finish_reason !== "stop")
    return undefined
  if (
    choice.message.content?.trim()
    || typeof choice.message.refusal === "string"
  )
    return undefined
  const calls = choice.message.tool_calls
  if (calls?.length !== 1 || calls[0].function.name !== name || !calls[0].id)
    return undefined
  return calls[0]
}

function failedRecovery(
  original: ToolSchemaMismatchError,
  outcome: string,
): HTTPError {
  const message = `${original.message} StructuredOutput regeneration ${outcome}; no further automatic attempt was made. Check the declared schema and requested output.`
  return new HTTPError(
    message,
    Response.json(
      {
        type: "error",
        error: { type: "api_error", message },
      },
      { status: 502 },
    ),
  )
}

export function addRecoveryUsage(
  original: ChatCompletionResponse["usage"],
  repaired: ChatCompletionResponse["usage"],
): ChatCompletionResponse["usage"] {
  if (!original && !repaired) return undefined
  const first = original ?? {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  }
  const second = repaired ?? {
    prompt_tokens: 0,
    completion_tokens: 0,
    total_tokens: 0,
  }
  const cached =
    (first.prompt_tokens_details?.cached_tokens ?? 0)
    + (second.prompt_tokens_details?.cached_tokens ?? 0)
  const cacheCreation =
    (first.prompt_tokens_details?.cache_creation_tokens ?? 0)
    + (second.prompt_tokens_details?.cache_creation_tokens ?? 0)
  return {
    prompt_tokens: first.prompt_tokens + second.prompt_tokens,
    completion_tokens: first.completion_tokens + second.completion_tokens,
    total_tokens: first.total_tokens + second.total_tokens,
    ...(first.prompt_tokens_details || second.prompt_tokens_details ?
      {
        prompt_tokens_details: {
          cached_tokens: cached,
          ...(cacheCreation > 0 ?
            { cache_creation_tokens: cacheCreation }
          : {}),
        },
      }
    : {}),
  }
}

function regenerationInstruction(original: ToolSchemaMismatchError): string {
  return (
    "Return the requested final output using exactly one StructuredOutput call matching its unchanged input_schema. "
    + "The previous output failed schema validation: "
    + original.diagnostics
      .map((item) => `${item.keyword} at ${item.location}`)
      .join("; ")
    + ". Re-derive the answer from the original conversation, respect all original constraints, and do not invent missing user data. "
    + "Do not call any executable tool or add explanatory prose. If the requested output cannot be produced safely and accurately, decline instead."
  )
}

function regenerationPayload(
  payload: AnthropicMessagesPayload,
  original: ToolSchemaMismatchError,
): AnthropicMessagesPayload {
  return {
    ...payload,
    stream: false,
    tools: payload.tools?.filter(
      (tool) => !isTypedTool(tool) && tool.name === "StructuredOutput",
    ),
    tool_choice: { type: "auto" },
    messages: [
      ...payload.messages,
      { role: "user", content: regenerationInstruction(original) },
    ],
  }
}

// eslint-disable-next-line max-lines-per-function -- One deadline and terminal outcome cover the complete atomic regeneration.
async function regenerate(
  context: RecoveryContext,
  original: ToolSchemaMismatchError,
): Promise<AnthropicResponse> {
  const { payload, response, map, signal: downstream, complete } = context
  if (hasNativeMessagesThinking(response)) {
    throw failedRecovery(
      original,
      "cannot safely combine regenerated output with signed native thinking",
    )
  }
  const name = toOpenAIToolName("StructuredOutput", map)
  const call = soleOutputCall(response, name)
  const tool = payload.tools?.find(
    (entry) => !isTypedTool(entry) && entry.name === "StructuredOutput",
  )
  if (!call || !tool || isTypedTool(tool)) throw original
  downstream.throwIfAborted()
  const controller = new AbortController()
  const timeout = setTimeout(
    () =>
      controller.abort(
        new Error("StructuredOutput regeneration exceeded 20 seconds"),
      ),
    STRUCTURED_OUTPUT_RECOVERY_TIMEOUT_MS,
  )
  const signal = AbortSignal.any([downstream, controller.signal])
  consola.warn("StructuredOutput schema mismatch; one bounded regeneration", {
    diagnostics: original.diagnostics,
    timeoutMs: STRUCTURED_OUTPUT_RECOVERY_TIMEOUT_MS,
  })
  let received = false
  try {
    // Discard the invalid output completely. Only the original conversation
    // and unchanged schema are evidence; no candidate text becomes instructions.
    const repairPayload = regenerationPayload(payload, original)
    const repairMap = createToolNameMapFromAnthropicPayload(repairPayload)
    const repairName = toOpenAIToolName("StructuredOutput", repairMap)
    const repaired = await complete(repairPayload, signal)
    signal.throwIfAborted()
    if (hasNativeMessagesThinking(repaired)) {
      throw failedRecovery(
        original,
        "regeneration returned context-bound signed native thinking",
      )
    }
    received = true
    const repairedCall = soleOutputCall(repaired, repairName)
    if (!repairedCall || repaired.model !== response.model) {
      throw failedRecovery(
        original,
        "returned a different identity, incomplete turn, refusal, or additional output",
      )
    }
    parseToolInput(
      repairedCall.function.arguments,
      repairName,
      tool.input_schema,
    )
    signal.throwIfAborted()
    return translateToAnthropic(
      {
        ...response,
        choices: [
          {
            ...response.choices[0],
            message: {
              ...response.choices[0].message,
              tool_calls: [
                {
                  ...call,
                  function: {
                    ...call.function,
                    arguments: repairedCall.function.arguments,
                  },
                },
              ],
            },
          },
        ],
        usage: addRecoveryUsage(response.usage, repaired.usage),
      },
      map,
    )
  } catch (error) {
    if (downstream.aborted) throw downstream.reason
    if (controller.signal.aborted)
      throw failedRecovery(original, "timed out after 20 seconds")
    if (error instanceof ToolSchemaMismatchError) {
      throw failedRecovery(original, "still failed schema validation")
    }
    // Authentication, policy and other explicit upstream failures must retain
    // their status/details, not enter any empty-response or model fallback.
    if (error instanceof HTTPError && !received) throw error
    if (error instanceof HTTPError) {
      throw failedRecovery(
        original,
        "returned invalid arguments, a different identity, refusal, or additional output",
      )
    }
    throw failedRecovery(original, "failed before a valid output was received")
  } finally {
    clearTimeout(timeout)
  }
}

export async function translateWithOutputRecovery(
  payload: AnthropicMessagesPayload,
  response: ChatCompletionResponse,
  options: RecoveryOptions,
): Promise<AnthropicResponse> {
  const { map, signal } = options
  signal.throwIfAborted()
  if (
    response.choices.some(
      (choice) =>
        typeof choice.message.refusal === "string"
        || choice.finish_reason === "content_filter",
    )
  ) {
    return translateToAnthropic(
      {
        ...response,
        choices: response.choices.map((choice) => ({
          ...choice,
          finish_reason: "content_filter",
          message: {
            ...choice.message,
            content: choice.message.refusal ?? choice.message.content,
            tool_calls: undefined,
          },
        })),
      },
      map,
    )
  }
  try {
    return translateToAnthropic(response, map)
  } catch (error) {
    if (!(error instanceof ToolSchemaMismatchError)) throw error
    return regenerate({ payload, response, ...options }, error)
  }
}
