#!/usr/bin/env node

import { defineCommand } from "citty"
import clipboard from "clipboardy"
import consola from "consola"
import { serve, type ServerHandler } from "srvx"
import invariant from "tiny-invariant"

import { ensurePaths } from "./lib/paths"
import { initProxyFromEnv } from "./lib/proxy"
import { generateEnvScript } from "./lib/shell"
import { state } from "./lib/state"
import { setupCopilotToken, setupGitHubToken } from "./lib/token"
import { cacheModels, cacheVSCodeVersion } from "./lib/utils"
import { server } from "./server"
import {
  getModelContextWindow,
  getModelMaxOutput,
} from "./services/copilot/get-models"

interface RunServerOptions {
  port: number
  verbose: boolean
  accountType: string
  manual: boolean
  rateLimit?: number
  rateLimitWait: boolean
  burstCount?: number
  burstWindowSeconds?: number
  githubToken?: string
  claudeCode: boolean
  showToken: boolean
  proxyEnv: boolean
}

/** Formats a number as "Nk" if >= 1000, otherwise as-is. */
const formatK = (v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : `${v}`)

// eslint-disable-next-line max-lines-per-function
export async function runServer(options: RunServerOptions): Promise<void> {
  if (options.proxyEnv) {
    initProxyFromEnv()
  }

  if (options.verbose) {
    consola.level = 5
    consola.info("Verbose logging enabled")
  }

  state.accountType = options.accountType
  if (options.accountType !== "individual") {
    consola.info(`Using ${options.accountType} plan GitHub account`)
  }

  state.manualApprove = options.manual
  state.rateLimitSeconds = options.rateLimit
  state.rateLimitWait = options.rateLimitWait
  state.burstCount = options.burstCount
  state.burstWindowSeconds = options.burstWindowSeconds
  state.showToken = options.showToken

  const tavilyApiKey = process.env.TAVILY_API_KEY
  const braveApiKey = process.env.BRAVE_API_KEY

  if (tavilyApiKey) {
    state.tavilyApiKey = tavilyApiKey
    consola.info("Web search enabled (Tavily)")
    consola.info(
      "Note: each web search request uses 2-3 internal Copilot API calls "
        + "(not counted against the rate limit).",
    )
  } else if (braveApiKey) {
    state.braveApiKey = braveApiKey
    consola.info("Web search enabled (Brave)")
    consola.info(
      "Note: each web search request uses 2-3 internal Copilot API calls "
        + "(not counted against the rate limit).",
    )
  }

  await ensurePaths()
  await cacheVSCodeVersion()

  if (options.githubToken) {
    state.githubToken = options.githubToken
    consola.info("Using provided GitHub token")
  } else {
    await setupGitHubToken()
  }

  await setupCopilotToken()
  await cacheModels()

  const modelList = state.models?.data
    .map((model) => {
      const maxOut = getModelMaxOutput(model)
      const ctxWindow = getModelContextWindow(model)
      const parts: Array<string> = []
      if (ctxWindow) parts.push(`ctx: ${formatK(ctxWindow)}`)
      if (maxOut) parts.push(`out: ${formatK(maxOut)}`)
      const suffix = parts.length > 0 ? ` (${parts.join(", ")})` : ""
      return `- ${model.id}${suffix}`
    })
    .join("\n")
  consola.info(`Available models: \n${modelList}`)

  const serverUrl = `http://localhost:${options.port}`

  if (options.claudeCode) {
    invariant(state.models, "Models should be loaded by now")

    const selectedModel = await consola.prompt(
      "Select a model to use with Claude Code",
      {
        type: "select",
        options: state.models.data.map((model) => model.id),
      },
    )

    const selectedSmallModel = await consola.prompt(
      "Select a small model to use with Claude Code",
      {
        type: "select",
        options: state.models.data.map((model) => model.id),
      },
    )

    const command = generateEnvScript(
      {
        ANTHROPIC_BASE_URL: serverUrl,
        ANTHROPIC_AUTH_TOKEN: "dummy",
        ANTHROPIC_MODEL: selectedModel,
        ANTHROPIC_DEFAULT_SONNET_MODEL: selectedModel,
        ANTHROPIC_SMALL_FAST_MODEL: selectedSmallModel,
        ANTHROPIC_DEFAULT_HAIKU_MODEL: selectedSmallModel,
        DISABLE_NON_ESSENTIAL_MODEL_CALLS: "1",
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      },
      "claude",
    )

    try {
      clipboard.writeSync(command)
      consola.success("Copied Claude Code command to clipboard!")
    } catch {
      consola.warn(
        "Failed to copy to clipboard. Here is the Claude Code command:",
      )
      consola.log(command)
    }
  }

  consola.box(
    `🌐 Usage Viewer: https://ericc-ch.github.io/copilot-api?endpoint=${serverUrl}/usage`,
  )

  const srvxServer = serve({
    fetch: server.fetch as ServerHandler,
    port: options.port,
    // Copilot responses can take several minutes for long generations;
    // disable Bun's default 10-second idle timeout to prevent premature 500s.
    // srvx forwards the `bun` object directly to Bun.serve as extra options.
    bun: { idleTimeout: 0 },
  })

  // Add visual separation after srvx prints its "Listening on:" line
  void srvxServer.ready().then(() => console.log())
}

export const start = defineCommand({
  meta: {
    name: "start",
    description: "Start the Copilot API server",
  },
  args: {
    port: {
      alias: "p",
      type: "string",
      default: "4141",
      description: "Port to listen on",
    },
    verbose: {
      alias: "v",
      type: "boolean",
      default: false,
      description: "Enable verbose logging",
    },
    "account-type": {
      alias: "a",
      type: "string",
      default: "individual",
      description: "Account type to use (individual, business, enterprise)",
    },
    manual: {
      type: "boolean",
      default: false,
      description: "Enable manual request approval",
    },
    "rate-limit": {
      alias: "r",
      type: "string",
      description: "Rate limit in seconds between requests",
    },
    wait: {
      alias: "w",
      type: "boolean",
      default: false,
      description:
        "Wait instead of error when rate limit is hit. Has no effect if rate limit is not set",
    },
    "burst-count": {
      type: "string",
      description:
        "Max requests allowed within the burst window (positive integer). Must be used with --burst-window.",
    },
    "burst-window": {
      type: "string",
      description:
        "Burst window duration in seconds (positive number). Must be used with --burst-count.",
    },
    "github-token": {
      alias: "g",
      type: "string",
      description:
        "Provide GitHub token directly (must be generated using the `auth` subcommand)",
    },
    "claude-code": {
      alias: "c",
      type: "boolean",
      default: false,
      description:
        "Generate a command to launch Claude Code with Copilot API config",
    },
    "show-token": {
      type: "boolean",
      default: false,
      description: "Show GitHub and Copilot tokens on fetch and refresh",
    },
    "proxy-env": {
      type: "boolean",
      default: false,
      description: "Initialize proxy from environment variables",
    },
  },
  run({ args }) {
    const rateLimitRaw = args["rate-limit"]
    const rateLimit =
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      rateLimitRaw === undefined ? undefined : Number.parseInt(rateLimitRaw, 10)

    const rawBurstCount = args["burst-count"]
    const rawBurstWindow = args["burst-window"]

    let burstCount: number | undefined
    let burstWindowSeconds: number | undefined

    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (rawBurstCount !== undefined && rawBurstWindow !== undefined) {
      const parsedCount = Number(rawBurstCount)
      if (!Number.isInteger(parsedCount) || parsedCount < 1) {
        consola.error(
          `--burst-count must be a positive integer (got: ${rawBurstCount})`,
        )
        process.exit(1)
      }

      const parsedWindow = Number(rawBurstWindow)
      if (!(parsedWindow > 0) || !Number.isFinite(parsedWindow)) {
        consola.error(
          `--burst-window must be a positive number greater than 0 (got: ${rawBurstWindow})`,
        )
        process.exit(1)
      }

      burstCount = parsedCount
      burstWindowSeconds = parsedWindow
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    } else if (rawBurstCount !== undefined || rawBurstWindow !== undefined) {
      const missing =
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
        rawBurstCount === undefined ? "--burst-count" : "--burst-window"
      consola.error(
        `--burst-count and --burst-window must both be provided (missing: ${missing})`,
      )
      process.exit(1)
    }

    return runServer({
      port: Number.parseInt(args.port, 10),
      verbose: args.verbose,
      accountType: args["account-type"],
      manual: args.manual,
      rateLimit,
      rateLimitWait: args.wait,
      githubToken: args["github-token"],
      claudeCode: args["claude-code"],
      showToken: args["show-token"],
      proxyEnv: args["proxy-env"],
      burstCount,
      burstWindowSeconds,
    })
  },
})
