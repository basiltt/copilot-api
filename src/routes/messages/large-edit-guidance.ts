import type { ChatCompletionsPayload } from "~/services/copilot/create-chat-completions"

const FILE_EDIT_TOOL_NAMES = new Set([
  "Edit",
  "MultiEdit",
  "NotebookEdit",
  "Write",
])

const GUIDANCE_MARKER = "File-editing budget:"
const STRONG_GUIDANCE_MARKER = "High-risk large edit detected:"

const RISKY_REQUEST_PATTERNS = [
  /\bcomplete\b/i,
  /\bcomprehensive\b/i,
  /\bentire\b/i,
  /\bfull file\b/i,
  /\bwhole file\b/i,
  /\bone giant\b/i,
  /\bone shot\b/i,
  /\bsingle (?:write|edit|tool call|operation)\b/i,
  /\bdo not split\b/i,
  /\bexactly once\b/i,
  /\bthousands? of lines\b/i,
  /\b\d{4,}\s+lines\b/i,
  /\brewrite the file\b/i,
  /\bwrite the complete\b/i,
]

function hasFileEditTool(payload: ChatCompletionsPayload): boolean {
  return (
    payload.tools?.some((tool) => FILE_EDIT_TOOL_NAMES.has(tool.function.name))
    ?? false
  )
}

function alreadyHasGuidance(payload: ChatCompletionsPayload): boolean {
  return payload.messages.some(
    (message) =>
      message.role === "system"
      && typeof message.content === "string"
      && (message.content.includes(GUIDANCE_MARKER)
        || message.content.includes(STRONG_GUIDANCE_MARKER)),
  )
}

function isRiskyLargeEditRequest(payload: ChatCompletionsPayload): boolean {
  return payload.messages.some((message) => {
    if (message.role !== "user") return false
    if (typeof message.content !== "string") return false
    return RISKY_REQUEST_PATTERNS.some((pattern) =>
      pattern.test(message.content),
    )
  })
}

function buildGuidance(modelMaxOutput: number, strong: boolean): string {
  const base =
    `${GUIDANCE_MARKER} this model can emit about ${modelMaxOutput.toLocaleString()} output tokens in one turn. `
    + "When using Write/Edit/MultiEdit-style tools, never attempt one giant file rewrite. "
  if (!strong) {
    return (
      base
      + "For large file creation or large edits, split the work into multiple smaller tool calls "
      + "(for example staged edits, chunked appends, or a script written in pieces) so each tool call stays well below the output limit."
    )
  }

  return (
    `${STRONG_GUIDANCE_MARKER} the user request looks likely to overflow a single tool call on this model. `
    + base
    + "Do not satisfy this request with one massive Write/Edit/MultiEdit call, even if the user asks for a complete file in one step. "
    + "Instead, choose a chunked strategy: create a scaffold first, then append or patch the file in multiple sequential tool calls, "
    + "or generate a helper script and write that script in smaller pieces."
  )
}

export function applyLargeEditGuidance(
  payload: ChatCompletionsPayload,
  modelMaxOutput: number | undefined,
): void {
  if (!modelMaxOutput || modelMaxOutput > 32_000) return
  if (!hasFileEditTool(payload) || alreadyHasGuidance(payload)) return
  const strongGuidance = isRiskyLargeEditRequest(payload)

  payload.messages.unshift({
    role: "system",
    content: buildGuidance(modelMaxOutput, strongGuidance),
  })
}
