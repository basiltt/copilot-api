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
  getModelTotalContext,
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
  burstMinSpacingMs: number
  burstScope: "global" | "model"
  githubToken?: string
  claudeCode: boolean
  showToken: boolean
  proxyEnv: boolean
}

/** Formats a number as "Nk" if >= 1000, otherwise as-is. */
const formatK = (v: number) => (v >= 1000 ? `${Math.round(v / 1000)}k` : `${v}`)

interface TlsSetup {
  tls: { cert: string; key: string; passphrase?: string } | undefined
  scheme: "http" | "https"
}

/**
 * Resolves optional TLS config from env. HTTPS is enabled when BOTH TLS_CERT
 * and TLS_KEY are set (file paths or inline PEM — srvx reads files for us).
 * Exits if only one is provided. Returns plain-HTTP defaults when neither is
 * set, preserving the original behavior.
 */
function resolveTlsSetup(): TlsSetup {
  const cert = process.env.TLS_CERT?.trim()
  const key = process.env.TLS_KEY?.trim()

  if (Boolean(cert) !== Boolean(key)) {
    consola.error(
      "TLS misconfiguration: set BOTH TLS_CERT and TLS_KEY, or neither.",
    )
    process.exit(1)
  }

  if (!cert || !key) {
    return { tls: undefined, scheme: "http" }
  }

  consola.info("TLS enabled — server will listen over HTTPS")
  return {
    tls: { cert, key, passphrase: process.env.TLS_PASSPHRASE },
    scheme: "https",
  }
}

function configureSearchProvider(): void {
  const provider = process.env.WEB_SEARCH_PROVIDER?.trim().toLowerCase()
  if (
    provider !== undefined
    && provider !== "copilot"
    && provider !== "tavily"
    && provider !== "brave"
    && provider !== "off"
  ) {
    throw new Error(
      "WEB_SEARCH_PROVIDER must be copilot, tavily, brave, or off.",
    )
  }
  state.webSearchProvider = provider
  state.tavilyApiKey = process.env.TAVILY_API_KEY
  state.braveApiKey = process.env.BRAVE_API_KEY
  if (
    (provider === "tavily" && !state.tavilyApiKey)
    || (provider === "brave" && !state.braveApiKey)
  ) {
    throw new Error(
      `WEB_SEARCH_PROVIDER=${provider} requires its matching API key.`,
    )
  }
  if (provider === "copilot") {
    consola.info(
      "Copilot native MCP search selected; each search requires advertised read-only web_search. No third-party fallback.",
    )
  } else if (provider === "off") {
    consola.info("Web search disabled")
  } else if (state.tavilyApiKey && provider !== "brave") {
    consola.info(
      "Web search enabled (Tavily); internal Copilot search passes are not counted against the request rate limit.",
    )
  } else if (state.braveApiKey) {
    consola.info(
      "Web search enabled (Brave); internal Copilot search passes are not counted against the request rate limit.",
    )
  }
}

export function configureStructuredOutputRecovery(): void {
  const value = process.env.STRUCTURED_OUTPUT_RECOVERY?.trim().toLowerCase()
  if (value !== undefined && !["0", "1", "false", "true"].includes(value)) {
    throw new Error("STRUCTURED_OUTPUT_RECOVERY must be 0, 1, false, or true.")
  }
  state.structuredOutputRecovery = value === "1" || value === "true"
  if (state.structuredOutputRecovery) {
    consola.info(
      "StructuredOutput output-only recovery enabled: one same-model regeneration, maximum 20s; executable tools are not recovered.",
    )
  }
}

export function configureWriteToolRecovery(): void {
  const value = process.env.WRITE_TOOL_RECOVERY?.trim()
  if (value !== undefined && value !== "0" && value !== "1") {
    throw new Error("WRITE_TOOL_RECOVERY must be 0 or 1.")
  }
  state.writeToolRecovery = value === "1"
  if (state.writeToolRecovery) {
    consola.info(
      "Write missing-content recovery enabled: one same-model correction, maximum 20s; the proxy does not execute tools.",
    )
  }
}

// eslint-disable-next-line max-lines-per-function -- Startup ordering coordinates authentication, configuration, and server lifetime.
export async function runServer(options: RunServerOptions): Promise<void> {
  if (options.proxyEnv) {
    initProxyFromEnv()
  }

  if (options.verbose) {
    consola.level = 5
    consola.info("Verbose logging enabled")
  }

  const imageTrimmingEnabled =
    process.env.IMAGE_CONTEXT_TRIMMING_ENABLED?.trim().toLowerCase()
  if (
    imageTrimmingEnabled === "1"
    || imageTrimmingEnabled === "true"
    || imageTrimmingEnabled === "yes"
    || imageTrimmingEnabled === "on"
  ) {
    const threshold = process.env.IMAGE_CONTEXT_TRIMMING_BEFORE_MESSAGES ?? "6"
    consola.info(
      `Processed image trimming enabled (older than ${threshold} message(s))`,
    )
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
  state.burstMinSpacingMs = options.burstMinSpacingMs
  state.burstScope = options.burstScope
  state.showToken = options.showToken

  configureSearchProvider()
  configureStructuredOutputRecovery()
  configureWriteToolRecovery()

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
      const totalCtx = getModelTotalContext(model)
      const inputLimit = getModelContextWindow(model)
      const maxOut = getModelMaxOutput(model)
      const parts: Array<string> = []
      if (totalCtx) parts.push(`total: ${formatK(totalCtx)}`)
      if (inputLimit) parts.push(`in: ${formatK(inputLimit)}`)
      if (maxOut) parts.push(`out: ${formatK(maxOut)}`)
      const suffix = parts.length > 0 ? ` (${parts.join(", ")})` : ""
      return `- ${model.id}${suffix}`
    })
    .join("\n")
  consola.info(`Available models: \n${modelList}`)

  // Optional TLS: enable HTTPS when TLS_CERT/TLS_KEY are set (see
  // resolveTlsSetup). When unset, the server stays on plain HTTP (unchanged).
  const { tls, scheme } = resolveTlsSetup()

  const serverUrl = `${scheme}://localhost:${options.port}`

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
    // Enable HTTPS when TLS_CERT/TLS_KEY are set; otherwise stay on HTTP.
    tls,
    // Copilot responses can take several minutes for long generations;
    // disable Bun's default 10-second idle timeout to prevent premature 500s.
    // srvx forwards the `bun` object directly to Bun.serve as extra options.
    bun: { idleTimeout: 0 },
  })

  // Add visual separation after srvx prints its "Listening on:" line
  void srvxServer.ready().then(() => console.log())
}

function parseRateLimit(raw: string | undefined): number | undefined {
  const value = raw === undefined ? undefined : Number(raw)
  if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
    consola.error(
      "--rate-limit must be a finite, non-negative number of seconds",
    )
    process.exit(1)
  }
  return value
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
    "min-spacing": {
      type: "string",
      description:
        "Minimum spacing between requests in milliseconds (default: 0). Prevents thundering herd.",
    },
    "burst-scope": {
      type: "string",
      description:
        'Burst limit scope: "global" (default) or "model" (per-model burst tracking).',
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
    const rateLimit = parseRateLimit(rateLimitRaw)

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

    const rawMinSpacing = args["min-spacing"]
    const minSpacingMs = rawMinSpacing ? Number(rawMinSpacing) : 0
    if (!Number.isFinite(minSpacingMs) || minSpacingMs < 0) {
      consola.error(
        `--min-spacing must be a non-negative number in milliseconds (got: ${rawMinSpacing})`,
      )
      process.exit(1)
    }

    const rawBurstScope = args["burst-scope"]
    const burstScope: "global" | "model" =
      rawBurstScope === "model" ? "model" : "global"

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
      burstMinSpacingMs: minSpacingMs,
      burstScope,
    })
  },
})
