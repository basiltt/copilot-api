import type {
  ChatCompletionResponse,
  ChatCompletionChunk,
} from "~/services/copilot/create-chat-completions"

export function chatCompletionSSE(response: ChatCompletionResponse): Response {
  const envelope = {
    id: response.id,
    object: "chat.completion.chunk" as const,
    created: response.created,
    model: response.model,
    ...(response.system_fingerprint ?
      { system_fingerprint: response.system_fingerprint }
    : {}),
  }
  const chunks: Array<ChatCompletionChunk> = [
    {
      ...envelope,
      choices: response.choices.map((choice) => ({
        index: choice.index,
        delta: {
          role: choice.message.role,
          ...(choice.message.content !== null ?
            { content: choice.message.content }
          : {}),
          ...(choice.message.reasoning_content !== undefined ?
            { reasoning_content: choice.message.reasoning_content }
          : {}),
          ...(choice.message.reasoning_text !== undefined ?
            { reasoning_text: choice.message.reasoning_text }
          : {}),
          ...(choice.message.refusal !== undefined ?
            { refusal: choice.message.refusal }
          : {}),
          ...(choice.message.tool_calls ?
            {
              tool_calls: choice.message.tool_calls.map((call, index) => ({
                index,
                ...call,
              })),
            }
          : {}),
        },
        finish_reason: choice.finish_reason,
        logprobs: choice.logprobs,
      })),
    },
    ...(response.usage ?
      [{ ...envelope, choices: [], usage: response.usage }]
    : []),
  ]
  return new Response(
    chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join("")
      + "data: [DONE]\n\n",
    { headers: { "content-type": "text/event-stream" } },
  )
}
