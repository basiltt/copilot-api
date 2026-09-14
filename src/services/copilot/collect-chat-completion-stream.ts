import { HTTPError } from "~/lib/error"
import {
  responseEvents,
  UpstreamEventStreamLimitError,
} from "~/lib/upstream-lifecycle"

import type {
  ChatCompletionResponse,
  ToolCall,
} from "./create-chat-completions"

export const ONE_SHOT_CHAT_STREAM_MAX_BYTES = 32 * 1024 * 1024

type FinishReason = "stop" | "length" | "tool_calls" | "content_filter"

interface MutableToolCall {
  idFragments: Array<string>
  nameFragments: Array<string>
  arguments: string
}

interface MutableChoice {
  content: string
  finishReason?: FinishReason
  reasoningContent: string
  refusal: string
  sawContent: boolean
  sawReasoning: boolean
  sawRefusal: boolean
  tools: Map<number, MutableToolCall>
}

function invalidStream(message: string): HTTPError {
  const publicMessage = `Upstream streamed completion ${message}.`
  return new HTTPError(
    "Invalid Copilot streamed completion",
    Response.json(
      {
        type: "error",
        error: { type: "api_error", message: publicMessage },
      },
      { status: 502 },
    ),
  )
}

function streamedError(value: unknown): HTTPError {
  const source = isRecord(value) ? value : {}
  const error = {
    type: typeof source.type === "string" ? source.type : "api_error",
    message:
      typeof source.message === "string" ?
        source.message
      : "Upstream streamed completion failed.",
    ...(typeof source.code === "string" || typeof source.code === "number" ?
      { code: source.code }
    : {}),
  }
  return new HTTPError(
    "Copilot streamed completion failed",
    Response.json({ type: "error", error }, { status: 502 }),
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
}

function nonnegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || (value as number) < 0)
    throw invalidStream(`contained an invalid ${label}`)
  return value as number
}

function optionalTokenCount(
  record: Record<string, unknown>,
  key: string,
): number | undefined {
  if (record[key] === undefined || record[key] === null) return undefined
  return nonnegativeInteger(record[key], "usage count")
}

// eslint-disable-next-line complexity -- Optional usage fields are validated without filling absent counters.
function parseUsage(
  value: unknown,
): NonNullable<ChatCompletionResponse["usage"]> {
  if (!isRecord(value)) throw invalidStream("contained invalid usage metadata")
  const promptTokens = nonnegativeInteger(
    value.prompt_tokens,
    "prompt token count",
  )
  const completionTokens = nonnegativeInteger(
    value.completion_tokens,
    "completion token count",
  )
  const totalTokens = nonnegativeInteger(
    value.total_tokens,
    "total token count",
  )
  let promptDetails:
    | NonNullable<ChatCompletionResponse["usage"]>["prompt_tokens_details"]
    | undefined
  if (
    value.prompt_tokens_details !== undefined
    && value.prompt_tokens_details !== null
  ) {
    if (!isRecord(value.prompt_tokens_details))
      throw invalidStream("contained invalid prompt usage details")
    const cachedTokens = optionalTokenCount(
      value.prompt_tokens_details,
      "cached_tokens",
    )
    const cacheCreationTokens = optionalTokenCount(
      value.prompt_tokens_details,
      "cache_creation_tokens",
    )
    if (cachedTokens !== undefined || cacheCreationTokens !== undefined)
      promptDetails = {
        ...(cachedTokens !== undefined ? { cached_tokens: cachedTokens } : {}),
        ...(cacheCreationTokens !== undefined ?
          { cache_creation_tokens: cacheCreationTokens }
        : {}),
      }
  }
  let completionDetails:
    | NonNullable<ChatCompletionResponse["usage"]>["completion_tokens_details"]
    | undefined
  if (
    value.completion_tokens_details !== undefined
    && value.completion_tokens_details !== null
  ) {
    if (!isRecord(value.completion_tokens_details))
      throw invalidStream("contained invalid completion usage details")
    const acceptedPredictionTokens = optionalTokenCount(
      value.completion_tokens_details,
      "accepted_prediction_tokens",
    )
    const rejectedPredictionTokens = optionalTokenCount(
      value.completion_tokens_details,
      "rejected_prediction_tokens",
    )
    const reasoningTokens = optionalTokenCount(
      value.completion_tokens_details,
      "reasoning_tokens",
    )
    if (
      acceptedPredictionTokens !== undefined
      || rejectedPredictionTokens !== undefined
      || reasoningTokens !== undefined
    )
      completionDetails = {
        ...(acceptedPredictionTokens !== undefined ?
          { accepted_prediction_tokens: acceptedPredictionTokens }
        : {}),
        ...(rejectedPredictionTokens !== undefined ?
          { rejected_prediction_tokens: rejectedPredictionTokens }
        : {}),
        ...(reasoningTokens !== undefined ?
          { reasoning_tokens: reasoningTokens }
        : {}),
      }
  }
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: totalTokens,
    ...(promptDetails ? { prompt_tokens_details: promptDetails } : {}),
    ...(completionDetails ?
      { completion_tokens_details: completionDetails }
    : {}),
  }
}

function appendOptionalString(
  delta: Record<string, unknown>,
  key: string,
  append: (value: string) => void,
): void {
  const value = delta[key]
  if (value === undefined || value === null) return
  if (typeof value !== "string")
    throw invalidStream(`contained an invalid ${key} delta`)
  append(value)
}

function collectToolCalls(
  value: unknown,
  tools: Map<number, MutableToolCall>,
): void {
  if (value === undefined || value === null) return
  if (!Array.isArray(value))
    throw invalidStream("contained invalid tool-call deltas")
  for (const entry of value) {
    if (!isRecord(entry))
      throw invalidStream("contained an invalid tool-call delta")
    const index = nonnegativeInteger(entry.index, "tool-call index")
    if (
      entry.type !== undefined
      && entry.type !== null
      && entry.type !== "function"
    )
      throw invalidStream("contained an unsupported tool-call type")
    const tool = tools.get(index) ?? {
      idFragments: [],
      nameFragments: [],
      arguments: "",
    }
    appendOptionalString(entry, "id", (fragment) => {
      tool.idFragments.push(fragment)
    })
    if (entry.function !== undefined && entry.function !== null) {
      if (!isRecord(entry.function))
        throw invalidStream("contained an invalid tool function delta")
      appendOptionalString(entry.function, "name", (fragment) => {
        tool.nameFragments.push(fragment)
      })
      appendOptionalString(entry.function, "arguments", (fragment) => {
        tool.arguments += fragment
      })
    }
    tools.set(index, tool)
  }
}

function finishReason(value: unknown): FinishReason | undefined {
  if (value === undefined || value === null) return undefined
  if (
    value === "stop"
    || value === "length"
    || value === "tool_calls"
    || value === "content_filter"
  )
    return value
  throw invalidStream("contained an invalid finish reason")
}

function collectChoice(
  value: unknown,
  choices: Map<number, MutableChoice>,
): void {
  if (!isRecord(value)) throw invalidStream("contained an invalid choice")
  const index = nonnegativeInteger(value.index, "choice index")
  if (!isRecord(value.delta))
    throw invalidStream("contained an invalid choice delta")
  const choice: MutableChoice = choices.get(index) ?? {
    content: "",
    reasoningContent: "",
    refusal: "",
    sawContent: false,
    sawReasoning: false,
    sawRefusal: false,
    tools: new Map<number, MutableToolCall>(),
  }
  if (choice.finishReason !== undefined)
    throw invalidStream("contained data after a terminal choice")
  if (
    value.delta.role !== undefined
    && value.delta.role !== null
    && value.delta.role !== "assistant"
  )
    throw invalidStream("contained an invalid assistant role")
  appendOptionalString(value.delta, "content", (fragment) => {
    choice.sawContent = true
    choice.content += fragment
  })
  const reasoning = value.delta.reasoning_content ?? value.delta.reasoning_text
  if (reasoning !== undefined && reasoning !== null) {
    if (typeof reasoning !== "string")
      throw invalidStream("contained an invalid reasoning delta")
    choice.sawReasoning = true
    choice.reasoningContent += reasoning
  }
  appendOptionalString(value.delta, "refusal", (fragment) => {
    choice.sawRefusal = true
    choice.refusal += fragment
  })
  collectToolCalls(value.delta.tool_calls, choice.tools)
  const terminal = finishReason(value.finish_reason)
  if (terminal !== undefined) choice.finishReason = terminal
  choices.set(index, choice)
}

function resolveToolId(fragments: Array<string>): string | undefined {
  let id = ""
  for (const fragment of fragments) {
    if (!fragment) continue
    if (fragment === id) continue
    if (fragment.startsWith(id)) {
      id = fragment
      continue
    }
    if (
      /^(?:call|toolu)_[\w-]+$/.test(id)
      && /^(?:call|toolu)_[\w-]+$/.test(fragment)
    )
      throw invalidStream("changed a tool-call identity")
    id += fragment
  }
  return id || undefined
}

function resolveToolName(
  fragments: Array<string>,
  allowedToolNames?: ReadonlySet<string>,
): string | undefined {
  const values = fragments.filter(Boolean)
  if (values.length === 0) return undefined
  if (allowedToolNames) {
    const concatenated = values.join("")
    const candidates = new Set<string>()
    if (allowedToolNames.has(concatenated)) candidates.add(concatenated)
    for (const value of values) {
      if (allowedToolNames.has(value)) candidates.add(value)
    }
    if (candidates.size === 1) return [...candidates][0]
    if (candidates.size > 1)
      throw invalidStream("contained an ambiguous tool name")
    throw invalidStream("changed a tool name")
  }
  let name = ""
  for (const fragment of values) {
    if (fragment === name) continue
    name = fragment.startsWith(name) ? fragment : name + fragment
  }
  return name
}

function finalizedToolCalls(
  choice: MutableChoice,
  allowedToolNames?: ReadonlySet<string>,
): Array<ToolCall> | undefined {
  const { finishReason: terminal, sawRefusal: refused, tools } = choice
  if (tools.size === 0 || refused || terminal === "content_filter")
    return undefined
  const result: Array<ToolCall> = []
  for (const [, tool] of [...tools.entries()].sort(
    ([left], [right]) => left - right,
  )) {
    let id: string | undefined
    let name: string | undefined
    try {
      id = resolveToolId(tool.idFragments)
      name = resolveToolName(tool.nameFragments, allowedToolNames)
    } catch (error) {
      if (terminal === "length") continue
      throw error
    }
    if (!id || !name) {
      if (terminal === "length") continue
      throw invalidStream("ended with incomplete tool identity")
    }
    result.push({
      id,
      type: "function",
      function: { name, arguments: tool.arguments },
    })
  }
  return result.length > 0 ? result : undefined
}

// eslint-disable-next-line max-lines-per-function, complexity -- One state machine validates the complete SSE protocol before releasing output.
export async function collectChatCompletionStream(
  response: Response,
  signal: AbortSignal,
  options: {
    allowedToolNames?: ReadonlySet<string>
    maxBytes?: number
  } = {},
): Promise<ChatCompletionResponse> {
  let id: string | undefined
  let model: string | undefined
  let created: number | undefined
  let systemFingerprint: string | undefined
  let usage: ChatCompletionResponse["usage"]
  let done = false
  const choices = new Map<number, MutableChoice>()

  try {
    for await (const event of responseEvents(
      response,
      signal,
      options.maxBytes ?? ONE_SHOT_CHAT_STREAM_MAX_BYTES,
    )) {
      if (!event.data) continue
      if (event.data === "[DONE]") {
        done = true
        break
      }
      let chunk: unknown
      try {
        chunk = JSON.parse(event.data) as unknown
      } catch {
        throw invalidStream("contained malformed JSON")
      }
      if (!isRecord(chunk)) throw invalidStream("contained a non-object event")
      if ("error" in chunk && chunk.error) throw streamedError(chunk.error)
      if (
        chunk.object !== "chat.completion.chunk"
        || typeof chunk.id !== "string"
        || !chunk.id
        || typeof chunk.model !== "string"
        || !chunk.model
        || typeof chunk.created !== "number"
        || !Number.isFinite(chunk.created)
        || !Array.isArray(chunk.choices)
      )
        throw invalidStream("contained an invalid chunk envelope")
      if (
        (id !== undefined && id !== chunk.id)
        || (model !== undefined && model !== chunk.model)
        || (created !== undefined && created !== chunk.created)
      )
        throw invalidStream("changed response identity")
      id = chunk.id
      model = chunk.model
      created = chunk.created
      if (
        chunk.system_fingerprint !== undefined
        && chunk.system_fingerprint !== null
      ) {
        if (
          typeof chunk.system_fingerprint !== "string"
          || (systemFingerprint !== undefined
            && systemFingerprint !== chunk.system_fingerprint)
        )
          throw invalidStream("changed the system fingerprint")
        systemFingerprint = chunk.system_fingerprint
      }
      if (chunk.usage !== undefined && chunk.usage !== null)
        usage = parseUsage(chunk.usage)
      for (const choice of chunk.choices) collectChoice(choice, choices)
    }
  } catch (error) {
    if (error instanceof UpstreamEventStreamLimitError)
      throw invalidStream("exceeded the buffered wire limit")
    throw error
  }

  signal.throwIfAborted()
  if (!done) throw invalidStream("ended before the [DONE] marker")
  if (!id || !model || created === undefined || choices.size === 0)
    throw invalidStream("ended without a complete response")

  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [...choices.entries()]
      .sort(([left], [right]) => left - right)
      .map(([index, choice]) => {
        if (choice.finishReason === undefined)
          throw invalidStream("ended before a terminal choice")
        const toolCalls = finalizedToolCalls(choice, options.allowedToolNames)
        return {
          index,
          message: {
            role: "assistant",
            content: choice.sawContent ? choice.content : null,
            ...(choice.sawReasoning ?
              { reasoning_content: choice.reasoningContent }
            : {}),
            ...(choice.sawRefusal ? { refusal: choice.refusal } : {}),
            ...(toolCalls ? { tool_calls: toolCalls } : {}),
          },
          logprobs: null,
          finish_reason: choice.finishReason,
        }
      }),
    ...(systemFingerprint ? { system_fingerprint: systemFingerprint } : {}),
    ...(usage ? { usage } : {}),
  }
}
