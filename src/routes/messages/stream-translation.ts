import { type ChatCompletionChunk } from "~/services/copilot/create-chat-completions"

import {
  type AnthropicStreamEventData,
  type AnthropicStreamState,
} from "./anthropic-types"
import { mapOpenAIStopReasonToAnthropic, toAnthropicMessageId } from "./utils"

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

    if (state.thinkingEnabled) {
      // Emit as a proper thinking block so Claude Code's thinking UI
      // displays the reasoning content with real-time streaming.
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
    } else {
      // Thinking not enabled — emit as regular text so content is visible.
      if (!state.contentBlockOpen) {
        events.push({
          type: "content_block_start",
          index: state.contentBlockIndex,
          content_block: { type: "text", text: "" },
        })
        state.contentBlockOpen = true
        state.thinkingBlockOpen = true
      }

      events.push({
        type: "content_block_delta",
        index: state.contentBlockIndex,
        delta: { type: "text_delta", text: delta.reasoning_content },
      })
    }
    state.hasEmittedText = true
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

    events.push({
      type: "content_block_delta",
      index: state.contentBlockIndex,
      delta: {
        type: "text_delta",
        text: delta.content,
      },
    })
    state.hasEmittedText = true
  }

  if (delta.tool_calls) {
    for (const toolCall of delta.tool_calls) {
      if (toolCall.id && toolCall.function?.name) {
        // New tool call starting.
        if (state.contentBlockOpen) {
          // Close any previously open block.
          events.push({
            type: "content_block_stop",
            index: state.contentBlockIndex,
          })
          state.contentBlockIndex++
          state.contentBlockOpen = false
          state.thinkingBlockOpen = false
        }

        // Inject a descriptive text block when the model hasn't emitted any
        // visible text before starting tool calls.  Models like Gemini go
        // straight to tool_use without any explanatory content — Claude Code
        // would show a loading animation with no indication of progress.
        // The description extracts key details from tool arguments (e.g.
        // file paths, commands) so the user sees what's actually happening.
        if (!state.hasEmittedText) {
          const description = describeToolCall(
            toolCall.function.name,
            toolCall.function.arguments,
          )
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
                text: description,
              },
            },
            {
              type: "content_block_stop",
              index: state.contentBlockIndex,
            },
          )
          state.contentBlockIndex++
          state.hasEmittedText = true
        }

        const anthropicBlockIndex = state.contentBlockIndex
        state.toolCalls[toolCall.index] = {
          id: toolCall.id,
          name: toolCall.function.name,
          anthropicBlockIndex,
          accumulatedArgs: "",
        }

        events.push({
          type: "content_block_start",
          index: anthropicBlockIndex,
          content_block: {
            type: "tool_use",
            id: toolCall.id,
            name: toolCall.function.name,
            input: {},
          },
        })
        state.contentBlockOpen = true
      }

      if (toolCall.function?.arguments) {
        const toolCallInfo = state.toolCalls[toolCall.index]
        // Tool call can still be empty
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        if (toolCallInfo) {
          toolCallInfo.accumulatedArgs += toolCall.function.arguments
          events.push({
            type: "content_block_delta",
            index: toolCallInfo.anthropicBlockIndex,
            delta: {
              type: "input_json_delta",
              partial_json: toolCall.function.arguments,
            },
          })
        }
      }
    }
  }

  if (choice.finish_reason) {
    // Detect truncated tool calls: when finish_reason is "length" and tool
    // calls have incomplete JSON arguments, the output hit the token limit
    // mid-tool-call.  Instead of passing broken JSON to Claude Code (which
    // would cause it to execute a tool with invalid input), emit an
    // explanatory text block and use "end_turn" so Claude Code adjusts its
    // strategy (e.g., writing files in smaller chunks).
    if (choice.finish_reason === "length") {
      const truncated = findTruncatedToolCalls(state)
      if (truncated.length > 0) {
        return emitTruncationGuardEvents(state, chunk, { events, truncated })
      }
    }

    const hasToolCalls = Object.keys(state.toolCalls).length > 0

    if (state.contentBlockOpen) {
      events.push({
        type: "content_block_stop",
        index: state.contentBlockIndex,
      })
      state.contentBlockOpen = false
    }

    // Some models (notably Gemini) intermittently return finish_reason "stop"
    // even when they emitted tool calls in the response. Claude Code interprets
    // stop_reason "end_turn" as "model is done" and skips pending tool
    // executions, causing the session to stall after a few rounds.
    // Detect this mismatch and correct finish_reason to "tool_calls".
    const correctedFinishReason =
      hasToolCalls && choice.finish_reason === "stop" ?
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
        stop_reason: mapOpenAIStopReasonToAnthropic(state.deferredFinishReason),
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
 * Empty accumulatedArgs are considered valid (no arguments to parse).
 */
export function findTruncatedToolCalls(
  state: AnthropicStreamState,
): Array<{ id: string; name: string; accumulatedArgs: string }> {
  return Object.values(state.toolCalls).filter((tc) => {
    if (!tc.accumulatedArgs) return false
    try {
      JSON.parse(tc.accumulatedArgs)
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
    && !choice.delta.content
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
function emitTruncationGuardEvents(
  state: AnthropicStreamState,
  chunk: ChatCompletionChunk,
  ctx: {
    events: Array<AnthropicStreamEventData>
    truncated: Array<{ name: string }>
  },
): Array<AnthropicStreamEventData> {
  const { events, truncated } = ctx

  if (state.contentBlockOpen) {
    events.push({
      type: "content_block_stop",
      index: state.contentBlockIndex,
    })
    state.contentBlockIndex++
    state.contentBlockOpen = false
  }

  const toolName = truncated[0].name
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
        text:
          `[Output truncated: the response exceeded the maximum output token limit`
          + ` while generating tool call "${toolName}".`
          + ` Please retry with a smaller output, e.g. write the file in smaller chunks.]`,
      },
    },
    {
      type: "content_block_stop",
      index: state.contentBlockIndex,
    },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: {
        input_tokens:
          ((state.lastSeenUsage ?? chunk.usage)?.prompt_tokens ?? 0)
          - ((state.lastSeenUsage ?? chunk.usage)?.prompt_tokens_details
            ?.cached_tokens ?? 0),
        output_tokens:
          (state.lastSeenUsage ?? chunk.usage)?.completion_tokens ?? 0,
      },
    },
    { type: "message_stop" },
  )
  state.messageStopSent = true
  return events
}

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
