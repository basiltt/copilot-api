import { describe, expect, test } from "bun:test"

import { translateToOpenAI } from "~/routes/messages/non-stream-translation"

describe("Workflow tool translation", () => {
  test("requires a Workflow selector and preserves input examples", () => {
    const inputSchema = {
      type: "object",
      properties: {
        script: { type: "string" },
        name: { type: "string" },
        scriptPath: { type: "string" },
        args: { type: "object" },
      },
    }
    const translated = translateToOpenAI({
      model: "claude-opus-5",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Run the workflow." }],
      tools: [
        {
          name: "Workflow",
          description: "Run a dynamic workflow.",
          input_schema: inputSchema,
          input_examples: [
            { name: "deep-research", args: { question: "Example question" } },
          ],
          eager_input_streaming: true,
        },
      ],
    })

    const workflow = translated.tools?.[0].function
    expect(workflow?.parameters).toEqual({
      ...inputSchema,
      anyOf: [
        { required: ["script"] },
        { required: ["name"] },
        { required: ["scriptPath"] },
      ],
    })
    expect(workflow?.description).toContain(
      '{"name":"deep-research","args":{"question":"Example question"}}',
    )
    expect(inputSchema).not.toHaveProperty("anyOf")
  })

  test("does not replace an existing Workflow selector union", () => {
    const anyOf = [{ required: ["script"] }, { required: ["name"] }]
    const translated = translateToOpenAI({
      model: "claude-opus-5",
      max_tokens: 1024,
      messages: [{ role: "user", content: "Run the workflow." }],
      tools: [
        {
          name: "Workflow",
          input_schema: {
            type: "object",
            properties: {
              script: { type: "string" },
              name: { type: "string" },
            },
            anyOf,
          },
        },
      ],
    })

    expect(translated.tools?.[0].function.parameters).toEqual({
      type: "object",
      properties: {
        script: { type: "string" },
        name: { type: "string" },
      },
      anyOf,
    })
  })
})
