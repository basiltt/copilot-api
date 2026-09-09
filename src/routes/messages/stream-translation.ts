import { type ChatCompletionChunk } from "~/services/copilot/create-chat-completions"

import {
  type AnthropicStreamEventData,
  type AnthropicStreamState,
} from "./anthropic-types"
import { invalidToolInput, parseToolInput } from "./tool-input"
import { toAnthropicToolIdentity } from "./tool-name-mapping"
import {
  EMPTY_VISIBLE_OUTPUT_TEXT,
  FILTERED_VISIBLE_OUTPUT_TEXT,
  mapOpenAIStopReasonToAnthropic,
  toAnthropicMessageId,
} from "./utils"

/**
 * Generates a human-readable description for a tool call so the user can see
 * what the model is doing.  Models like Gemini go straight to tool calls
 * without any explanatory text — this provides that missing context.
 *
 * When arguments are available (e.g. Gemini sends name + args in one chunk),
 * the description extracts key details like file paths and commands.
 * Otherwise falls back to just the tool name.
 */
function describeToolCall(name: string, rawArgs: string | undefined): string {
  // Try to parse arguments for richer descriptions
  const args = parseToolArgs(rawArgs)

  if (args) {
    // Bash tool — show the command (truncated if very long)
    if (typeof args.command === "string") {
      const cmd = args.command
      return `Running: ${cmd.length > 120 ? cmd.slice(0, 120) + "…" : cmd}`
    }
    // File-based tools — show the path with an action verb
    if (typeof args.file_path === "string") {
      return describeFileToolCall(name, args.file_path)
    }
    // Search tools — show the pattern
    if (typeof args.pattern === "string") {
      return describeSearchToolCall(name, args.pattern)
    }
    // WebFetch — show the URL
    if (typeof args.prompt === "string" && typeof args.url === "string") {
      return `Fetching: ${args.url}`
    }
  }

  return `Using tool: ${name}`
}

/** Safely parses JSON tool arguments, returning undefined on failure. */
function parseToolArgs(
  rawArgs: string | undefined,
): Record<string, unknown> | undefined {
  if (!rawArgs) return undefined
  try {
    return JSON.parse(rawArgs) as Record<string, unknown>
  } catch {
    return undefined
  }
}

/** Returns a description for file-path-based tools (Read, Write, Edit, etc.). */
function describeFileToolCall(name: string, filePath: string): string {
  const lower = name.toLowerCase()
  if (lower.includes("read") || name === "Read") return `Reading: ${filePath}`
  if (lower.includes("write") || name === "Write") return `Writing: ${filePath}`
  if (lower.includes("edit") || name === "Edit") return `Editing: ${filePath}`
  return `${name}: ${filePath}`
}

/** Returns a description for search-pattern-based tools (Glob, Grep, etc.). */
function describeSearchToolCall(name: string, pattern: string): string {
  const lower = name.toLowerCase()
  if (lower.includes("glob") || name === "Glob")
    return `Searching files: ${pattern}`
  if (lower.includes("grep") || name === "Grep")
    return `Searching for: ${pattern}`
  return `${name}: ${pattern}`
}

function isToolBlockOpen(state: AnthropicStreamState): boolean {
  if (!state.contentBlockOpen) {
    return false
  }
  // Check if the current block index corresponds to any known tool call
  return Object.values(state.toolCalls).some(
    (tc) => tc.anthropicBlockIndex === state.contentBlockIndex,
  )
}

/** Whether the currently open block is a thinking block. */
function isThinkingBlockOpen(state: AnthropicStreamState): boolean {
  return state.contentBlockOpen && state.thinkingBlockOpen
}

/**
 * Claude clients persist/replay Anthropic-style tool streams more reliably
 * when the assistant turn contains only the actual tool_use blocks.
 * Synthetic pre-tool text is mainly needed for models like Gemini that often
 * jump straight to tool calls without any visible narration.
 */
function shouldInjectSyntheticToolDescription(model: string): boolean {
  return !model.toLowerCase().startsWith("claude")
}

// eslint-disable-next-line max-lines-per-function, complexity
export function translateChunkToAnthropicEvents(
  chunk: ChatCompletionChunk,
  state: AnthropicStreamState,
): Array<AnthropicStreamEventData> {
  const events: Array<AnthropicStreamEventData> = []

  // Always capture usage from every chunk that has it.  With
  // `stream_options: { include_usage: true }`, the OpenAI API sends a
  // final chunk with `choices: []` and `usage` — we need to store it
  // so the deferred `message_delta` can include accurate `input_tokens`.
  if (chunk.usage) {
    state.lastSeenUsage = chunk.usage
  }

  if (chunk.choices.length === 0) {
    return events
  }

  const choice = chunk.choices[0]
  const { delta } = choice
  if (state.deferredFinishReason !== undefined || state.messageStopSent) {
    if (
      delta.content
      || delta.reasoning_content
      || delta.reasoning_text
      || delta.tool_calls?.length
    ) {
      throw invalidToolInput(
        "response",
        "received content after the terminal frame",
      )
    }
    return events
  }

  // OpenAI-compatible streams normally begin with a role-only chunk.  Do not
  // commit Anthropic's message_start for that protocol preamble: if the next
  // chunk is an empty terminal response, the caller can still retry without
  // having sent any part of a message to the client. Buffer leading whitespace
  // rather than dropping it so valid Markdown/code formatting is preserved
  // when visible text eventually arrives.
  const deltaText = delta.content ?? ""
  const hasSubstantiveDelta =
    Boolean(deltaText.trim())
    || Boolean(delta.reasoning_content)
    || Boolean(delta.reasoning_text)
    || Boolean(delta.tool_calls?.length)
  if (
    !state.messageStartSent
    && !choice.finish_reason
    && !hasSubstantiveDelta
  ) {
    if (deltaText) {
      state.pendingLeadingText = (state.pendingLeadingText ?? "") + deltaText
    }
    return events
  }

  if (!state.messageStartSent) {
    events.push({
      type: "message_start",
      message: {
        id: toAnthropicMessageId(chunk.id),
        type: "message",
        role: "assistant",
        content: [],
        model: chunk.model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens:
            (chunk.usage?.prompt_tokens ?? 0)
            - (chunk.usage?.prompt_tokens_details?.cached_tokens ?? 0),
          output_tokens: 0, // Will be updated in message_delta when finished
          ...(chunk.usage?.prompt_tokens_details?.cached_tokens
            !== undefined && {
            cache_read_input_tokens:
              chunk.usage.prompt_tokens_details.cached_tokens,
          }),
        },
      },
    })
    state.messageStartSent = true
  }

  // Normalize Gemini's reasoning_text → reasoning_content so the rest of
  // the logic only needs to check one field.  Gemini models send reasoning
  // output as `reasoning_text` while GPT models use `reasoning_content`.
  if (delta.reasoning_text && !delta.reasoning_content) {
    delta.reasoning_content = delta.reasoning_text
  }

  // Reasoning/thinking content from models like GPT 5.4 and Gemini.
  // When the client has `thinking` enabled, emit as proper Anthropic thinking
  // blocks so Claude Code displays them in its dedicated thinking UI.  When
  // thinking is not enabled, emit as regular text blocks so the content is
  // still visible to the user.
  if (delta.reasoning_content) {
    // If a tool block is open, close it first.
    if (isToolBlockOpen(state)) {
      events.push({
        type: "content_block_stop",
        index: state.contentBlockIndex,
      })
      state.contentBlockIndex++
      state.contentBlockOpen = false
      state.thinkingBlockOpen = false
    }

    // Always emit reasoning as a `thinking` block, regardless of whether the
    // client explicitly enabled thinking.
    //
    // Previously, when `thinking` was absent from the request, reasoning was
    // downgraded to a `text` block.  Copilot emits `reasoning_content` for
    // reasoning-capable models whether or not we asked for it, so the model's
    // private chain-of-thought was rendered to the user as ordinary assistant
    // prose — e.g. a reply that opened with "The user wants a brief greeting
    // in just three words."  Claude Desktop renders `thinking` blocks in
    // dedicated collapsed UI and ignores them when absent, so routing
    // reasoning there is correct in both cases and never leaks into the
    // visible answer.
    if (!state.contentBlockOpen) {
      events.push({
        type: "content_block_start",
        index: state.contentBlockIndex,
        content_block: { type: "thinking", thinking: "" },
      })
      state.contentBlockOpen = true
      state.thinkingBlockOpen = true
    }

    events.push({
      type: "content_block_delta",
      index: state.contentBlockIndex,
      delta: { type: "thinking_delta", thinking: delta.reasoning_content },
    })
    state.hasEmittedThinking = true
  }

  if (delta.content) {
    // If a thinking block is open, close it before starting a text block.
    if (isThinkingBlockOpen(state)) {
      events.push({
        type: "content_block_stop",
        index: state.contentBlockIndex,
      })
      state.contentBlockIndex++
      state.contentBlockOpen = false
      state.thinkingBlockOpen = false
    }

    if (isToolBlockOpen(state)) {
      // A tool block was open, so close it before starting a text block.
      events.push({
        type: "content_block_stop",
        index: state.contentBlockIndex,
      })
      state.contentBlockIndex++
      state.contentBlockOpen = false
    }

    if (!state.contentBlockOpen) {
      events.push({
        type: "content_block_start",
        index: state.contentBlockIndex,
        content_block: {
          type: "text",
          text: "",
        },
      })
      state.contentBlockOpen = true
    }

    const text = (state.pendingLeadingText ?? "") + delta.content
    state.pendingLeadingText = undefined
    events.push({
      type: "content_block_delta",
      index: state.contentBlockIndex,
      delta: {
        type: "text_delta",
        text,
      },
    })
    if (text.trim().length > 0) {
      state.hasEmittedText = true
    }
  }

  if (delta.tool_calls) {
    for (const toolCall of delta.tool_calls) {
      const info = (state.toolCalls[toolCall.index] ??= {
        id: "",
        name: "",
        anthropicBlockIndex: -1,
        accumulatedArgs: "",
      })
      if (toolCall.id && info.id !== toolCall.id) info.id += toolCall.id
      if (toolCall.function?.name && info.name !== toolCall.function.name) {
        info.name += toolCall.function.name
      }
      info.accumulatedArgs += toolCall.function?.arguments ?? ""
    }
  }

  if (choice.finish_reason) {
    const hasToolCalls = Object.keys(state.toolCalls).length > 0

    // A filtered tool call must never be committed as a normal Anthropic tool
    // turn. The tool block may already have streamed, so terminate the partial
    // message with an error; clients discard errored turns instead of executing
    // or replaying their tool_use blocks.
    if (choice.finish_reason === "content_filter" && hasToolCalls) {
      if (state.contentBlockOpen) {
        events.push({
          type: "content_block_stop",
          index: state.contentBlockIndex,
        })
        state.contentBlockOpen = false
        state.thinkingBlockOpen = false
      }
      events.push(
        translateErrorToAnthropicErrorEvent(
          FILTERED_VISIBLE_OUTPUT_TEXT,
          "invalid_request_error",
        ),
      )
      state.messageStopSent = true
      state.deferredFinishReason = undefined
      return events
    }

    if (state.contentBlockOpen) {
      events.push({
        type: "content_block_stop",
        index: state.contentBlockIndex,
      })
      state.contentBlockOpen = false
      state.thinkingBlockOpen = false
      state.contentBlockIndex++
    }

    events.push(...emitBufferedToolCalls(state, chunk.model))

    // A reasoning-only or policy-filtered completion is not a usable Claude
    // response.  Once thinking has streamed we cannot transparently retry (a
    // second message_start would violate the Anthropic SSE protocol), so close
    // the same message with explicit, visible text instead of a silent end_turn.
    const isFiltered = choice.finish_reason === "content_filter"
    if (!state.hasEmittedText && (!hasToolCalls || isFiltered)) {
      const fallbackText =
        (state.pendingLeadingText ?? "")
        + (choice.finish_reason === "content_filter" ?
          FILTERED_VISIBLE_OUTPUT_TEXT
        : EMPTY_VISIBLE_OUTPUT_TEXT)
      state.pendingLeadingText = undefined
      events.push(
        {
          type: "content_block_start",
          index: state.contentBlockIndex,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: state.contentBlockIndex,
          delta: { type: "text_delta", text: fallbackText },
        },
        {
          type: "content_block_stop",
          index: state.contentBlockIndex,
        },
      )
      state.hasEmittedText = true
      state.contentBlockIndex++
    }

    /**
     * Tool blocks are committed only after the upstream turn completes. This also
     * prevents interleaved parallel arguments from arriving after a block's stop.
     */
    function emitBufferedToolCalls(
      state: AnthropicStreamState,
      model: string,
    ): Array<AnthropicStreamEventData> {
      const calls = Object.values(state.toolCalls)
      for (const call of calls) {
        if (!call.id || !call.name) {
          throw invalidToolInput(
            call.name || "unknown",
            "missing tool identity",
          )
        }
        parseToolInput(
          call.accumulatedArgs,
          call.name,
          state.toolNameMap?.inputSchemas?.[call.name],
        )
      }
      const events: Array<AnthropicStreamEventData> = []
      for (const call of calls) {
        const identity = toAnthropicToolIdentity(call.name, state.toolNameMap)
        const { name } = identity
        if (
          !state.hasEmittedText
          && shouldInjectSyntheticToolDescription(model)
        ) {
          events.push(
            {
              type: "content_block_start",
              index: state.contentBlockIndex,
              content_block: { type: "text", text: "" },
            },
            {
              type: "content_block_delta",
              index: state.contentBlockIndex,
              delta: {
                type: "text_delta",
                text: describeToolCall(name, call.accumulatedArgs),
              },
            },
            { type: "content_block_stop", index: state.contentBlockIndex },
          )
          state.contentBlockIndex++
          state.hasEmittedText = true
        }
        call.anthropicBlockIndex = state.contentBlockIndex
        events.push(
          {
            type: "content_block_start",
            index: state.contentBlockIndex,
            content_block: {
              type: "tool_use",
              id: call.id,
              ...identity,
              input: {},
            },
          },
          {
            type: "content_block_delta",
            index: state.contentBlockIndex,
            delta: {
              type: "input_json_delta",
              partial_json: call.accumulatedArgs,
            },
          },
          { type: "content_block_stop", index: state.contentBlockIndex },
        )
        state.contentBlockIndex++
      }
      return events
    }

    // Some models (notably Gemini) intermittently return a non-tool_calls
    // finish_reason ("stop", or a non-standard string) even when they emitted
    // tool calls. Claude Code interprets stop_reason "end_turn" as "model is
    // done" and skips pending tool executions, stalling the session. Coerce to
    // "tool_calls" whenever tool calls are present, EXCEPT for "length" (which
    // is handled by the truncation guard above and must be preserved). This
    // mirrors the non-streaming correction in non-stream-translation.ts.
    const correctedFinishReason =
      (
        hasToolCalls
        && choice.finish_reason !== "length"
        && choice.finish_reason !== "content_filter"
      ) ?
        "tool_calls"
      : choice.finish_reason

    // Defer message_delta + message_stop instead of emitting immediately.
    // When `stream_options: { include_usage: true }` is set, the usage chunk
    // (with accurate prompt_tokens) arrives AFTER this finish_reason chunk.
    // By deferring, we let `flushDeferredFinish()` emit these events with
    // the real usage data once the stream ends or the usage chunk arrives.
    state.deferredFinishReason = correctedFinishReason
  }

  return events
}

/**
 * Emits the deferred `message_delta` + `message_stop` events after the stream
 * has ended.  This is called from the stream handler after all chunks have been
 * processed, so the accumulated `lastSeenUsage` contains the final usage data
 * (from the usage-only chunk sent by the OpenAI API with `stream_options`).
 *
 * If no finish was deferred (stream ended without finish_reason), returns empty.
 */
export function flushDeferredFinish(
  state: AnthropicStreamState,
): Array<AnthropicStreamEventData> {
  if (state.deferredFinishReason === undefined) return []

  const usage = state.lastSeenUsage
  const events: Array<AnthropicStreamEventData> = [
    {
      type: "message_delta",
      delta: {
        // Backstop: the terminating message_delta must carry a non-null
        // stop_reason. mapOpenAIStopReasonToAnthropic returns undefined for a
        // non-standard finish_reason string (which JSON drops, violating the
        // Anthropic streaming protocol), so coalesce — to "tool_use" when tool
        // calls were emitted, else "end_turn". Mirrors the non-streaming
        // backstop in non-stream-translation.ts.
        stop_reason:
          mapOpenAIStopReasonToAnthropic(state.deferredFinishReason)
          ?? (Object.keys(state.toolCalls).length > 0 ?
            "tool_use"
          : "end_turn"),
        stop_sequence: null,
      },
      usage: {
        input_tokens:
          (usage?.prompt_tokens ?? 0)
          - (usage?.prompt_tokens_details?.cached_tokens ?? 0),
        output_tokens: usage?.completion_tokens ?? 0,
        ...(usage?.prompt_tokens_details?.cached_tokens !== undefined && {
          cache_read_input_tokens: usage.prompt_tokens_details.cached_tokens,
        }),
      },
    },
    {
      type: "message_stop",
    },
  ]
  state.messageStopSent = true
  state.deferredFinishReason = undefined
  return events
}

/**
 * Includes missing, non-object, and schema-invalid arguments.
 */
export function findTruncatedToolCalls(
  state: AnthropicStreamState,
): Array<{ id: string; name: string; accumulatedArgs: string }> {
  return Object.values(state.toolCalls).filter((tc) => {
    try {
      parseToolInput(
        tc.accumulatedArgs,
        tc.name,
        state.toolNameMap?.inputSchemas?.[tc.name],
      )
      return false
    } catch {
      return true
    }
  })
}

/**
 * Detects whether a raw SSE chunk represents a complete but empty response.
 *
 * Some models (notably Gemini) occasionally return a single chunk with
 * `finish_reason: "stop"`, `content: null`, and zero tool calls after
 * completing their reasoning phase.  This is effectively a "model had
 * nothing to say" response.  When detected before `message_start` is sent,
 * the caller can retry the request transparently instead of passing an
 * empty turn to Claude Code (which would cause it to silently stop).
 */
export function isEmptyStreamResponse(chunk: ChatCompletionChunk): boolean {
  if (chunk.choices.length === 0) return false
  const choice = chunk.choices[0]
  return (
    choice.finish_reason === "stop"
    && !choice.delta.content?.trim()
    && !choice.delta.reasoning_content
    && !choice.delta.reasoning_text
    && (!choice.delta.tool_calls || choice.delta.tool_calls.length === 0)
  )
}

/**
 * Emits guard events when a tool call is truncated by the output token limit.
 * Closes the open tool block, emits an explanatory text block, and terminates
 * with stop_reason "end_turn" so Claude Code reads the feedback instead of
 * trying to execute a broken tool call.
 */
export function translateErrorToAnthropicErrorEvent(
  message: string = "An unexpected error occurred during streaming.",
  errorType: string = "api_error",
): AnthropicStreamEventData {
  return {
    type: "error",
    error: {
      type: errorType,
      message,
    },
  }
}
