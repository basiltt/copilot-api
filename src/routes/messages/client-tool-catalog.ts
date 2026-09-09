type Schema = Record<string, unknown>
type Properties = Record<string, Schema>

export interface ExpandedClientTool {
  name: string
  toolset_name?: string
  description?: string
  input_schema: Schema
  strict?: boolean
  defer_loading?: boolean
  input_examples?: Array<unknown>
}

const string: Schema = { type: "string" }
const number: Schema = { type: "number" }
const integer: Schema = { type: "integer" }
const boolean: Schema = { type: "boolean" }
const coordinate: Schema = {
  type: "array",
  items: number,
  minItems: 2,
  maxItems: 2,
}
const region: Schema = {
  type: "array",
  items: number,
  minItems: 4,
  maxItems: 4,
}
const directions: Schema = { enum: ["up", "down", "left", "right"] }
const repeat: Schema = { type: "integer", minimum: 1, maximum: 100 }
const viewRange: Schema = {
  type: "array",
  items: integer,
  minItems: 2,
  maxItems: 2,
}

function object(
  properties: Properties = {},
  required: Array<string> = [],
): Schema {
  return { type: "object", properties, required, additionalProperties: false }
}

const coordinateTarget = object(
  { type: { const: "coordinate" }, x: integer, y: integer },
  ["type", "x", "y"],
)
const refTarget = object({ type: { const: "ref" }, ref: string }, [
  "type",
  "ref",
])
const target = { oneOf: [coordinateTarget, refTarget] }

function browserMembers(): Record<string, Schema> {
  const members: Record<string, Schema> = Object.create(null) as Record<
    string,
    Schema
  >
  const add = (
    name: string,
    properties: Properties = {},
    required: Array<string> = [],
  ) => {
    members[name] = object({ ...properties, tab_id: string }, required)
  }
  add("navigate", { url: string }, ["url"])
  add("screenshot")
  add("zoom", { region }, ["region"])
  for (const name of [
    "left_click",
    "right_click",
    "middle_click",
    "double_click",
    "triple_click",
  ]) {
    add(name, { target, modifiers: string }, ["target"])
  }
  add("hover", { target }, ["target"])
  add("left_click_drag", { from: coordinateTarget, target: coordinateTarget }, [
    "from",
    "target",
  ])
  for (const name of ["left_mouse_down", "left_mouse_up", "mouse_move"]) {
    add(name, { target: coordinateTarget }, ["target"])
  }
  add(
    "scroll",
    {
      target: coordinateTarget,
      scroll_direction: directions,
      scroll_amount: { type: "integer", minimum: 1, maximum: 10, default: 3 },
    },
    ["target", "scroll_direction"],
  )
  add("scroll_to", { target: refTarget }, ["target"])
  add("type", { text: string }, ["text"])
  add("key", { text: string, repeat }, ["text"])
  const duration = { type: "number", minimum: 0, maximum: 30 }
  add("hold_key", { text: string, duration }, ["text", "duration"])
  add("wait", { duration }, ["duration"])
  add("read_page", {
    filter: { enum: ["interactive", "all"] },
    depth: { type: "integer", minimum: 1, default: 15 },
    ref: string,
  })
  add("find", { query: string }, ["query"])
  add("get_page_text")
  add(
    "form_input",
    { target: refTarget, value: { type: ["string", "number", "boolean"] } },
    ["target", "value"],
  )
  const paths = { type: "array", items: string, minItems: 1 }
  add("file_upload", { target: refTarget, paths, document_ids: paths }, [
    "target",
  ])
  members.file_upload.anyOf = [
    { required: ["paths"] },
    { required: ["document_ids"] },
  ]
  add("javascript_exec", { text: string }, ["text"])
  add("read_console")
  add("read_network")
  members.new_tab = object()
  members.list_tabs = object()
  members.switch_tab = object({ tab_id: string }, ["tab_id"])
  members.close_tab = object({ tab_id: string }, ["tab_id"])
  return members
}

function computerMembers(): Record<string, Schema> {
  const members: Record<string, Schema> = Object.create(null) as Record<
    string,
    Schema
  >
  for (const name of [
    "screenshot",
    "cursor_position",
    "left_mouse_down",
    "left_mouse_up",
  ])
    members[name] = object()
  members.zoom = object({ region }, ["region"])
  for (const name of [
    "left_click",
    "right_click",
    "middle_click",
    "double_click",
    "triple_click",
  ]) {
    members[name] = object({ coordinate, text: string })
  }
  members.left_click_drag = object(
    { start_coordinate: coordinate, coordinate, text: string },
    ["start_coordinate", "coordinate"],
  )
  members.mouse_move = object({ coordinate }, ["coordinate"])
  members.scroll = object(
    {
      scroll_direction: directions,
      scroll_amount: number,
      coordinate,
      text: string,
    },
    ["scroll_direction", "scroll_amount"],
  )
  members.type = object({ text: string }, ["text"])
  members.key = object({ text: string, repeat }, ["text"])
  const duration = { type: "number", minimum: 0, maximum: 300 }
  members.hold_key = object({ text: string, duration }, ["text", "duration"])
  members.wait = object({ duration }, ["duration"])
  return members
}

function validateFields(tool: Schema, fields: Array<string>) {
  const allowed = new Set([
    "type",
    "cache_control",
    "allowed_callers",
    ...fields,
  ])
  for (const field of Object.keys(tool)) {
    if (!allowed.has(field))
      throw new Error(`Unsupported ${String(tool.type)} option "${field}"`)
  }
  const callers = tool.allowed_callers
  if (
    callers !== undefined
    && (!Array.isArray(callers)
      || callers.length !== 1
      || callers[0] !== "direct")
  ) {
    throw new Error('Client tools support only allowed_callers: ["direct"]')
  }
}

function expandToolset(
  tool: Schema,
  browser: boolean,
): Array<ExpandedClientTool> {
  validateFields(tool, ["configs"])
  const members = browser ? browserMembers() : computerMembers()
  const disabled =
    browser ?
      new Set([
        "javascript_exec",
        "file_upload",
        "read_console",
        "read_network",
      ])
    : new Set<string>()
  const configs = new Map(Object.entries(toolsetConfigs(tool.configs)))
  for (const [name, config] of configs) {
    if (!Object.hasOwn(members, name))
      throw new Error(`Unknown toolset member "${name}"`)
    if (config.enabled === true) disabled.delete(name)
    if (config.enabled === false) disabled.add(name)
  }
  const toolset = browser ? "browser" : "computer"
  const tools = Object.entries(members)
    .filter(([name]) => !disabled.has(name))
    .map(([name, input_schema]) => ({
      name,
      toolset_name: toolset,
      input_schema,
      description: `Client-executed ${toolset}.${name}. The proxy does not perform this action.`,
    }))
  if (tools.length === 0)
    throw new Error("A toolset must enable at least one member")
  const deferrals = new Set(
    tools.map((member) => configs.get(member.name)?.defer_loading ?? false),
  )
  if (deferrals.size > 1)
    throw new Error("Enabled toolset members must use uniform defer_loading")
  if (
    deferrals.has(true)
    && tool.cache_control !== undefined
    && tool.cache_control !== null
  )
    throw new Error("Deferred toolsets cannot specify cache_control")
  return tools
}

function toolsetConfigs(
  raw: unknown,
): Record<string, { enabled?: boolean; defer_loading?: boolean }> {
  if (
    raw !== undefined
    && (!raw || typeof raw !== "object" || Array.isArray(raw))
  )
    throw new Error("configs must be an object")
  for (const [name, config] of Object.entries(
    (raw ?? {}) as Record<string, unknown>,
  )) {
    if (!config || typeof config !== "object" || Array.isArray(config))
      throw new Error(`Invalid config for "${name}"`)
    for (const [key, value] of Object.entries(config)) {
      if (
        (key !== "enabled" && key !== "defer_loading")
        || typeof value !== "boolean"
      )
        throw new Error(`Invalid config "${name}.${key}"`)
    }
  }
  return (raw ?? {}) as Record<
    string,
    { enabled?: boolean; defer_loading?: boolean }
  >
}

function command(
  name: string,
  properties: Properties,
  required: Array<string>,
): Schema {
  return object({ command: { const: name }, ...properties }, [
    "command",
    ...required,
  ])
}

function editorSchema(memory: boolean, undo: boolean): Schema {
  const commands = [
    command("view", { path: string, view_range: viewRange }, ["path"]),
    command("create", { path: string, file_text: string }, [
      "path",
      "file_text",
    ]),
    command(
      "str_replace",
      { path: string, old_str: string, new_str: string },
      memory ? ["path", "old_str"] : ["path", "old_str", "new_str"],
    ),
    command(
      "insert",
      { path: string, insert_line: integer, insert_text: string },
      ["path", "insert_line", "insert_text"],
    ),
  ]
  if (memory)
    commands.push(
      command("delete", { path: string }, ["path"]),
      command("rename", { old_path: string, new_path: string }, [
        "old_path",
        "new_path",
      ]),
    )
  if (undo) commands.push(command("undo_edit", { path: string }, ["path"]))
  return { type: "object", oneOf: commands }
}

export function expandClientTool(
  tool: Schema,
): Array<ExpandedClientTool> | undefined {
  if ("input_schema" in tool) return undefined
  if (tool.type === "browser_toolset_20260801") return expandToolset(tool, true)
  if (tool.type === "computer_toolset_20260801")
    return expandToolset(tool, false)
  if (tool.type === "computer_20250124" || tool.type === "computer_20251124")
    return [legacyComputer(tool)]
  let name: string
  let input_schema: Schema
  switch (tool.type) {
    case "bash_20250124": {
      name = "bash"
      input_schema = {
        ...object({ command: string, restart: boolean }),
        anyOf: [
          { required: ["command"] },
          { properties: { restart: { const: true } }, required: ["restart"] },
        ],
      }
      break
    }
    case "memory_20250818": {
      name = "memory"
      input_schema = editorSchema(true, false)
      break
    }
    case "text_editor_20250124":
    case "text_editor_20250429":
    case "text_editor_20250728": {
      name =
        tool.type === "text_editor_20250124" ?
          "str_replace_editor"
        : "str_replace_based_edit_tool"
      input_schema = editorSchema(false, tool.type === "text_editor_20250124")
      break
    }
    default: {
      return undefined
    }
  }
  validateFields(tool, [
    "name",
    "strict",
    "defer_loading",
    "input_examples",
    ...(tool.type === "text_editor_20250728" ? ["max_characters"] : []),
  ])
  if (tool.name !== name)
    throw new Error(`${tool.type} requires name "${name}"`)
  validateMaxCharacters(tool.max_characters)
  return [
    {
      name,
      input_schema,
      ...clientOptions(tool),
      description:
        `Client-executed ${name}; the proxy does not perform this action.`
        + (tool.max_characters !== undefined ?
          ` Client view output limit: ${String(tool.max_characters)} characters.`
        : ""),
    },
  ]
}

function validateMaxCharacters(
  value: unknown,
): asserts value is number | undefined {
  if (
    value !== undefined
    && (typeof value !== "number" || !Number.isInteger(value) || value < 1)
  ) {
    throw new Error("max_characters must be a positive integer")
  }
}

function clientOptions(
  tool: Schema,
): Pick<ExpandedClientTool, "strict" | "defer_loading" | "input_examples"> {
  const result: Pick<
    ExpandedClientTool,
    "strict" | "defer_loading" | "input_examples"
  > = {}
  for (const key of ["strict", "defer_loading"] as const) {
    if (tool[key] !== undefined) {
      if (typeof tool[key] !== "boolean")
        throw new Error(`${key} must be a boolean`)
      result[key] = tool[key]
    }
  }
  if (tool.input_examples !== undefined) {
    if (
      !Array.isArray(tool.input_examples)
      || !tool.input_examples.every(
        (example: unknown) =>
          example !== null
          && typeof example === "object"
          && !Array.isArray(example),
      )
    ) {
      throw new Error("input_examples must contain input objects")
    }
    result.input_examples = tool.input_examples as Array<unknown>
  }
  return result
}

function legacyComputer(tool: Schema): ExpandedClientTool {
  validateFields(tool, [
    "name",
    "display_width_px",
    "display_height_px",
    "display_number",
    "strict",
    "defer_loading",
    "input_examples",
    ...(tool.type === "computer_20251124" ? ["enable_zoom"] : []),
  ])
  if (tool.name !== "computer")
    throw new Error('Computer tools require name "computer"')
  for (const key of ["display_width_px", "display_height_px"]) {
    if (
      typeof tool[key] !== "number"
      || !Number.isInteger(tool[key])
      || tool[key] <= 0
    )
      throw new Error(`${key} must be a positive integer`)
  }
  if (
    tool.display_number !== undefined
    && tool.display_number !== null
    && (typeof tool.display_number !== "number"
      || !Number.isInteger(tool.display_number))
  )
    throw new Error("display_number must be an integer or null")
  if (tool.enable_zoom !== undefined && typeof tool.enable_zoom !== "boolean")
    throw new Error("enable_zoom must be a boolean")
  const members = computerMembers()
  members.key = object({ text: string }, ["text"])
  if (tool.enable_zoom !== true) delete members.zoom
  const actions = Object.entries(members).map(([action, schema]) => ({
    ...schema,
    properties: {
      ...(schema.properties as Properties),
      action: { const: action },
    },
    required: ["action", ...(schema.required as Array<string>)],
  }))
  return {
    name: "computer",
    input_schema: { type: "object", oneOf: actions },
    ...clientOptions(tool),
    description: `Client-executed computer (${String(tool.display_width_px)}x${String(tool.display_height_px)} pixels; display ${String(tool.display_number ?? "default")}). The proxy never controls a computer.`,
  }
}
