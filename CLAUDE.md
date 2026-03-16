# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

A reverse-engineered proxy that exposes the GitHub Copilot API as an OpenAI-compatible and Anthropic-compatible HTTP server. It handles authentication with GitHub's device flow, manages Copilot token refresh, and translates between API formats.

## Commands

```sh
# Install dependencies
bun install

# Development (watch mode)
bun run dev

# Production
bun run start

# Build (compiles to dist/ via tsdown)
bun run build

# Lint
bun run lint          # lint staged files
bun run lint:all      # lint entire project

# Type check
bun run typecheck

# Find unused exports/dependencies
bun run knip
```

## Architecture

### Entry Points
- `src/main.ts` — CLI entry point using `citty`. Registers subcommands: `start`, `auth`, `check-usage`, `debug`
- `src/start.ts` — Implements the `start` command: sets up state, authenticates, caches models/VSCode version, starts the Hono server via `srvx`
- `src/auth.ts` — Standalone GitHub OAuth device flow (without starting server)

### HTTP Server (`src/server.ts`)
Built with **Hono**. Routes are mounted at both `/` and `/v1/` prefixes for OpenAI compatibility:
- `POST /v1/chat/completions` → OpenAI-compatible chat completions
- `GET /v1/models` → list available Copilot models
- `POST /v1/embeddings` → embeddings
- `POST /v1/messages` + `POST /v1/messages/count_tokens` → Anthropic-compatible endpoints
- `GET /usage` → Copilot quota/usage stats
- `GET /token` → current Copilot token

### Anthropic ↔ OpenAI Translation (`src/routes/messages/`)
The messages route translates Anthropic API format to OpenAI format before forwarding to Copilot, then translates the response back:
- `non-stream-translation.ts` — bidirectional translation for non-streaming responses
- `stream-translation.ts` — translates OpenAI SSE chunks to Anthropic SSE event format
- `anthropic-types.ts` — TypeScript types for Anthropic request/response shapes

### Global State (`src/lib/state.ts`)
A single mutable `state` object holds runtime configuration and tokens:
- `githubToken` / `copilotToken` — authentication tokens
- `accountType` — `individual` | `business` | `enterprise` (affects Copilot API base URL)
- `models` / `vsCodeVersion` — cached at startup
- `manualApprove`, `rateLimitSeconds`, `rateLimitWait`, `showToken` — feature flags

### Authentication Flow (`src/lib/token.ts`)
1. Reads GitHub token from `~/.local/share/copilot-api/github_token`
2. If missing, triggers GitHub device-code OAuth flow
3. Exchanges GitHub token for a short-lived Copilot token via `src/services/github/get-copilot-token.ts`
4. Copilot token auto-refreshes on an interval (`refresh_in - 60` seconds)

### API Config & Headers (`src/lib/api-config.ts`)
Constructs headers that impersonate VS Code's Copilot Chat extension (required by GitHub's Copilot API). Copilot base URL varies by `accountType`:
- individual: `https://api.githubcopilot.com`
- business/enterprise: `https://api.{accountType}.githubcopilot.com`

### Services (`src/services/`)
- `copilot/create-chat-completions.ts` — core fetch to Copilot's `/chat/completions`; detects vision requests and agent vs. user calls via `X-Initiator` header
- `copilot/get-models.ts` / `create-embeddings.ts` — other Copilot API calls
- `github/` — device code OAuth, access token polling, Copilot token exchange, user info, usage stats

### Middleware / Lib
- `src/lib/rate-limit.ts` — enforces `rateLimitSeconds` between requests; can wait or error
- `src/lib/approval.ts` — interactive CLI prompt for `--manual` mode
- `src/lib/tokenizer.ts` — token counting using `gpt-tokenizer`
- `src/lib/proxy.ts` — initializes HTTP proxy from env vars (`HTTP_PROXY`, etc.) via `proxy-from-env` + `undici`
- `src/lib/shell.ts` — generates shell `env VAR=value command` strings for `--claude-code` flag

## Key Conventions

- **Path alias**: `~/` maps to `src/` (configured in tsconfig/tsdown), so imports use `~/lib/state` instead of relative paths
- **Runtime**: Bun is required (not Node.js); uses Bun's native APIs and `@types/bun`
- **Logging**: `consola` throughout — use `consola.debug` for verbose-only output, `consola.info` for normal output
- **Error handling**: `HTTPError` in `src/lib/error.ts` wraps fetch response errors
- **Validation**: `zod` for request payload validation; `tiny-invariant` for runtime assertions
- **Pre-commit**: `lint-staged` runs ESLint auto-fix on all staged files via `simple-git-hooks`
