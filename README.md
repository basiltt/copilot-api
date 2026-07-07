# Copilot API

A reverse-engineered proxy that turns the GitHub Copilot API into fully compatible **OpenAI** and **Anthropic** endpoints — letting you use Copilot with any tool that speaks either protocol, including [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview).

## Features

- **Triple API Compatibility** — OpenAI Chat Completions, OpenAI Responses API, and Anthropic Messages API, all backed by GitHub Copilot
- **Claude Code Integration** — Interactive model selector (`--claude-code`) copies a ready-to-paste launch command; full support for thinking blocks, typed tools, token counting, and auto-compaction
- **Automatic Endpoint Routing** — Models that only support `/responses` (e.g. gpt-5.4-mini) are transparently routed through the Responses API with bidirectional translation
- **Web Search** — Two-pass search via [Tavily](https://tavily.com) (free) or [Brave Search](https://brave.com/search/api/) — the proxy intercepts search tool calls, fetches live results, and injects them for the model
- **Smart Context Management** — Auto-switches to the largest-context model when token count exceeds the requested model's window; image stripping cascade on 413 errors to trigger compaction
- **Rate Limiting** — Interval-based and sliding-window burst limiting with configurable wait-or-reject behavior
- **Usage Dashboard** — Web UI showing Copilot quota, premium interactions, and detailed usage stats
- **Manual Approval Mode** — Interactively approve/deny each request (`--manual`)
- **Docker & npx** — Run anywhere: from source, via `npx copilot-api@latest`, or as a Docker container
- **Proxy Support** — HTTP/HTTPS proxy via environment variables with per-URL routing
- **Native HTTPS** — Serve over TLS with a self-signed cert (`TLS_CERT`/`TLS_KEY`) for secure LAN access — no reverse proxy needed

## Demo

https://github.com/user-attachments/assets/7654b383-669d-4eb9-b23c-06d7aefee8c5

## Architecture

### High-Level Request Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                          Clients                                    │
│  Claude Code · Cursor · OpenAI SDK · Anthropic SDK · Any HTTP       │
└──────────┬──────────────────┬──────────────────┬────────────────────┘
           │                  │                  │
           ▼                  ▼                  ▼
┌──────────────────┐ ┌───────────────┐ ┌─────────────────────┐
│ POST /v1/messages│ │ POST /v1/chat │ │ POST /v1/responses  │
│ (Anthropic API)  │ │ /completions  │ │ (Responses API)     │
└────────┬─────────┘ │ (OpenAI API)  │ └──────────┬──────────┘
         │           └───────┬───────┘            │
         ▼                   │                    ▼
┌──────────────────┐         │         ┌──────────────────────┐
│ Anthropic→OpenAI │         │         │ Responses↔CC         │
│ Translation      │         │         │ Translation          │
│ (bidirectional)  │         │         │ (bidirectional)      │
└────────┬─────────┘         │         └──────────┬───────────┘
         │                   │                    │
         ▼                   ▼                    ▼
┌─────────────────────────────────────────────────────────────────────┐
│                        Middleware Pipeline                           │
│  Rate Limiter → Burst Limiter → Manual Approval → Token Counter     │
│  → Model Selector → Web Search Interceptor → Image Validator        │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                     Copilot Service Layer                            │
│  ┌────────────────────────┐  ┌────────────────────────────────┐     │
│  │ POST /chat/completions │  │ POST /responses                │     │
│  │ (default endpoint)     │  │ (gpt-5.x, o-series models)    │     │
│  └────────────┬───────────┘  └────────────────┬───────────────┘     │
│               └────────────────┬──────────────┘                     │
│                                ▼                                    │
│              api.githubcopilot.com                                  │
│              api.business.githubcopilot.com                         │
│              api.enterprise.githubcopilot.com                       │
└─────────────────────────────────────────────────────────────────────┘
```

### Translation Layers

The proxy maintains three API protocol translators that convert between formats in real time, for both streaming and non-streaming responses:

```
┌─────────────────────────────────────────────────────────┐
│               Anthropic Messages API                     │
│  ┌─────────────────────────────────────────────────┐    │
│  │ Request: Anthropic → OpenAI                     │    │
│  │  • System blocks → system message               │    │
│  │  • Content blocks (text, image, doc, tool_result)│    │
│  │  • Thinking blocks → reasoning_content          │    │
│  │  • Typed tools (bash, text_editor, web_search)  │    │
│  │  • Tool choice (auto/any/tool/none)             │    │
│  │  • Model name normalization                     │    │
│  │  • Tool result compression (>20K chars)         │    │
│  │  • Image validation & stripping cascade         │    │
│  ├─────────────────────────────────────────────────┤    │
│  │ Response: OpenAI → Anthropic                    │    │
│  │  • SSE: message_start → content_block_start →   │    │
│  │    content_block_delta → content_block_stop →    │    │
│  │    message_delta → message_stop                  │    │
│  │  • reasoning_content → thinking blocks          │    │
│  │  • Tool calls → tool_use content blocks         │    │
│  │  • Truncated tool call detection                │    │
│  │  • Deferred finish_reason (waits for usage)     │    │
│  │  • 10s keepalive pings, 90s stall timeout       │    │
│  └─────────────────────────────────────────────────┘    │
├─────────────────────────────────────────────────────────┤
│               Responses API ↔ Chat Completions           │
│  ┌─────────────────────────────────────────────────┐    │
│  │ • Auto-routes models by supported_endpoints     │    │
│  │ • Claude models → Chat Completions translation  │    │
│  │ • gpt-5/o-series → Responses API translation   │    │
│  │ • Streaming event translation both directions   │    │
│  │ • JSON repair for truncated tool arguments      │    │
│  │ • Reasoning/thinking delta handling             │    │
│  └─────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────┘
```

### Authentication Flow

```
┌──────────┐    Device Code     ┌──────────┐    Poll Token     ┌──────────┐
│  Client   │ ───────────────► │  GitHub   │ ───────────────► │  GitHub  │
│  (CLI)    │ ◄─────────────── │  OAuth    │ ◄─────────────── │  Token   │
│           │  user_code +     │  Device   │   access_token   │  (PAT)   │
│           │  verification_url│  Flow     │                  │          │
└──────────┘                   └──────────┘                   └────┬─────┘
                                                                   │
                                     Stored at                     │
                          ~/.local/share/copilot-api/              │
                                  github_token                     │
                                                                   │
                                                                   ▼
┌──────────┐   Auto-refresh    ┌──────────────────────────────────────────┐
│  Copilot  │ ◄──────────────  │  GET /copilot_internal/v2/token         │
│  JWT      │  (refresh_in     │  Authorization: token <github_token>    │
│  Token    │   - 60 seconds)  │  → returns JWT with expiry              │
└──────────┘                   └──────────────────────────────────────────┘
```

### Web Search Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                    Two-Pass Web Search Flow                       │
│                                                                  │
│  Client Request (with web_search tool)                           │
│        │                                                         │
│        ▼                                                         │
│  ┌─────────────┐   Is it a web search?   ┌────────────────────┐ │
│  │  Interceptor │ ─────────────────────► │ Pass 1: Non-stream │ │
│  │  Detection   │   typed tool or         │ call to Copilot    │ │
│  │              │   recognized name       │ (asks what to      │ │
│  └──────────────┘                         │  search)           │ │
│                                           └────────┬───────────┘ │
│                                                    │             │
│                                                    ▼             │
│                                 ┌────────────────────────────┐   │
│                                 │  Execute Search             │   │
│                                 │  Tavily (preferred)         │   │
│                                 │   or Brave Search           │   │
│                                 │  5s timeout, max 5 results  │   │
│                                 └────────────┬───────────────┘   │
│                                              │                   │
│                                              ▼                   │
│                                 ┌────────────────────────────┐   │
│                                 │  Pass 2: Full call          │   │
│                                 │  Injects search results     │   │
│                                 │  tool_choice: "none"        │   │
│                                 │  (original stream mode)     │   │
│                                 └────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

### Project Structure

```
src/
├── main.ts                          # CLI entry point (citty subcommands)
├── start.ts                         # Server startup, auth, caching
├── auth.ts                          # Standalone OAuth device flow
├── server.ts                        # Hono app, route registration, middleware
│
├── routes/
│   ├── completions/                 # POST /v1/chat/completions
│   │   └── handler.ts
│   ├── responses/                   # POST /v1/responses (Responses API)
│   │   └── handler.ts
│   ├── messages/                    # POST /v1/messages (Anthropic API)
│   │   ├── handler.ts              #   request orchestration, retries, error handling
│   │   ├── non-stream-translation.ts  # Anthropic ↔ OpenAI (non-streaming)
│   │   ├── stream-translation.ts      # Anthropic ↔ OpenAI (SSE streaming)
│   │   ├── count-tokens.ts            # /v1/messages/count_tokens
│   │   └── anthropic-types.ts         # TypeScript types
│   ├── models/                      # GET /v1/models
│   ├── embeddings/                  # POST /v1/embeddings
│   ├── usage/                       # GET /usage
│   └── token/                       # GET /token
│
├── services/
│   ├── copilot/
│   │   ├── create-chat-completions.ts  # Core fetch to Copilot API
│   │   ├── create-embeddings.ts
│   │   ├── get-models.ts               # Model list + context window helpers
│   │   └── responses-translation.ts    # Responses ↔ Chat Completions translation
│   ├── github/
│   │   ├── get-copilot-token.ts        # JWT token exchange + auto-refresh
│   │   ├── get-copilot-usage.ts        # Quota/usage stats
│   │   ├── get-device-code.ts          # OAuth device flow
│   │   ├── get-user.ts                 # GitHub user info
│   │   └── poll-access-token.ts        # OAuth polling
│   └── web-search/
│       ├── interceptor.ts              # Two-pass search orchestration
│       ├── brave.ts                    # Brave Search provider
│       ├── tavily.ts                   # Tavily provider
│       ├── system-prompt.ts            # Search instruction injection
│       └── tool-definition.ts          # Tool detection & definition
│
└── lib/
    ├── api-config.ts                # Copilot API URLs & VS Code impersonation headers
    ├── error.ts                     # HTTPError, Anthropic error formatting
    ├── model-selector.ts            # Auto-switch to largest-context model
    ├── rate-limit.ts                # Interval + burst rate limiters
    ├── request-logger.ts            # Colored terminal logging middleware
    ├── session-id.ts                # Claude Code session ID extraction
    ├── shell.ts                     # Cross-shell env var generation
    ├── state.ts                     # Global mutable runtime state
    ├── token.ts                     # Token persistence & refresh
    ├── tokenizer.ts                 # gpt-tokenizer token counting
    ├── proxy.ts                     # HTTP proxy support (undici)
    ├── approval.ts                  # Interactive request approval
    └── paths.ts                     # Data directory paths
```

## Prerequisites

- [Bun](https://bun.sh) >= 1.2.x
- GitHub account with an active Copilot subscription (Individual, Business, or Enterprise)

## Installation

```sh
bun install
```

## Quick Start

```sh
# Via npx (no clone needed)
npx copilot-api@latest start

# From source
bun run dev    # development with watch mode
bun run start  # production
```

On first run, the proxy triggers GitHub's device-code OAuth flow — follow the on-screen URL to authorize.

### Quick Start (Windows)

The included `start.bat` handles everything automatically:

1. Create a `.env` file in the project root (see [Environment Variables](#environment-variables))
2. Double-click `start.bat` or run it from a terminal

The script will load env vars, build if needed, show the active search provider, start the server, and open the Usage Dashboard in your browser.

> Need HTTPS for access from another machine on your network? See [HTTPS / TLS (LAN Access)](#https--tls-lan-access).

## Environment Variables

Create a `.env` file in the project root. It is gitignored.

```env
# Web Search (optional — pick one)
TAVILY_API_KEY=tvly-...          # Preferred: free at tavily.com (1,000 req/mo)
BRAVE_API_KEY=BSA...             # Alternative: brave.com/search/api

# Proxy (optional)
HTTP_PROXY=http://proxy:8080
HTTPS_PROXY=http://proxy:8080

# HTTPS / TLS (optional — enables HTTPS when both are set)
TLS_CERT=certs/server.crt        # Path to certificate (PEM) or inline PEM
TLS_KEY=certs/server.key         # Path to private key (PEM) or inline PEM
TLS_PASSPHRASE=                  # Private key passphrase (only if encrypted)
```

> **Provider priority:** If both keys are set, Tavily is used.

> **TLS:** Set **both** `TLS_CERT` and `TLS_KEY` to serve over HTTPS; leave both unset for plain HTTP (default). See [HTTPS / TLS](#https--tls-lan-access).

## HTTPS / TLS (LAN Access)

By default the proxy serves plain **HTTP**, which is fine for `localhost`. If another machine on your network must reach the proxy over **HTTPS** (some clients refuse plain HTTP), the server can terminate TLS itself — no reverse proxy required.

HTTPS turns on automatically when both `TLS_CERT` and `TLS_KEY` are set (via `.env` or the environment). Each value may be a **file path** or an **inline PEM** string. If only one is set, the server exits with an error. When TLS is active the console prints `TLS enabled — server will listen over HTTPS` and the listening URL switches to `https://`.

### Quick Start (Windows)

The repo ships batch files that wire this up end to end:

1. **Generate a self-signed certificate** — run `generate-cert.bat`. It writes `certs/server.crt` and `certs/server.key`, with the certificate valid for your PC's LAN IP and hostname (Subject Alternative Names). Edit the `LAN_IP` and `HOSTNAME` values at the top of the script if yours differ.
2. **Start the server** — run `start.bat` (port 4141), `start-openai.bat` (port 1515), or `start-controlled.bat` (port 3131). Each script points `TLS_CERT`/`TLS_KEY` at `certs/` and refuses to start if the certificate is missing.
3. **Connect from the other machine** at `https://<LAN_IP>:<port>` (e.g. `https://192.168.0.105:4141`).

> The `certs/` directory is gitignored — your private key is never committed.

### Generating a certificate manually

Any tool that produces a PEM cert/key pair works. With OpenSSL, the key detail is that the **Subject Alternative Name (SAN) must list the exact IP or hostname** the client connects to — modern HTTPS clients validate against the SAN, not the Common Name:

```sh
openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes \
  -keyout certs/server.key -out certs/server.crt \
  -subj "/CN=YOUR-HOSTNAME" \
  -addext "subjectAltName=IP:192.168.0.105,IP:127.0.0.1,DNS:YOUR-HOSTNAME,DNS:localhost"
```

Verify the SANs landed correctly:

```sh
openssl x509 -in certs/server.crt -noout -subject -ext subjectAltName
```

### Trusting the certificate on the client

A self-signed certificate is rejected until the **connecting machine trusts it**. Copy `certs/server.crt` to that machine and install it as a trusted root:

- **Windows** (admin terminal): `certutil -addstore -f Root server.crt`
- **Node-based clients:** point `NODE_EXTRA_CA_CERTS` at the `.crt` file
- **curl / OpenSSL tools:** pass `--cacert server.crt` or set `SSL_CERT_FILE`

### Firewall

Windows Firewall blocks inbound connections by default. Allow the port on the machine running the proxy:

```sh
netsh advfirewall firewall add rule name="copilot-api 4141" dir=in action=allow protocol=TCP localport=4141
```

> **DHCP note:** The IP is baked into the certificate's SANs. If your LAN IP changes, update `LAN_IP` in `generate-cert.bat` and the start scripts, regenerate the certificate, and re-trust it on the client. A DHCP reservation (or connecting by hostname) avoids this.

## Command Structure

| Command | Description |
|---|---|
| `start` | Start the proxy server (handles auth if needed) |
| `auth` | Run GitHub OAuth flow without starting the server |
| `check-usage` | Show Copilot quota/usage in the terminal |
| `debug` | Display version, runtime, paths, and auth status |

### Start Command Options

| Option | Alias | Default | Description |
|---|---|---|---|
| `--port` | `-p` | `4141` | Port to listen on |
| `--verbose` | `-v` | `false` | Enable verbose logging |
| `--account-type` | `-a` | `individual` | `individual`, `business`, or `enterprise` |
| `--manual` | — | `false` | Require interactive approval for each request |
| `--rate-limit` | `-r` | — | Minimum seconds between requests |
| `--wait` | `-w` | `false` | Queue requests instead of rejecting when rate limited |
| `--burst-count` | — | — | Max requests in burst window |
| `--burst-window` | — | — | Burst window duration in seconds |
| `--github-token` | `-g` | — | Provide a pre-existing GitHub token (skip OAuth) |
| `--claude-code` | `-c` | `false` | Interactive Claude Code setup wizard |
| `--show-token` | — | `false` | Display tokens in logs for debugging |
| `--proxy-env` | — | `false` | Use `HTTP_PROXY`/`HTTPS_PROXY` from environment |

### Auth Command Options

| Option | Alias | Default | Description |
|---|---|---|---|
| `--verbose` | `-v` | `false` | Verbose logging |
| `--show-token` | — | `false` | Show token after auth |

### Debug Command Options

| Option | Default | Description |
|---|---|---|
| `--json` | `false` | Output as JSON |

## API Endpoints

### OpenAI Compatible

| Endpoint | Method | Description |
|---|---|---|
| `/v1/chat/completions` | POST | Chat completions (streaming & non-streaming) |
| `/v1/responses` | POST | OpenAI Responses API |
| `/v1/models` | GET | List available models (with context window metadata) |
| `/v1/embeddings` | POST | Generate embedding vectors |

### Anthropic Compatible

| Endpoint | Method | Description |
|---|---|---|
| `/v1/messages` | POST | Anthropic Messages API (full protocol translation) |
| `/v1/messages/count_tokens` | POST | Token counting with model-specific scaling |

### Utility

| Endpoint | Method | Description |
|---|---|---|
| `/usage` | GET | Copilot quota and usage statistics |
| `/token` | GET | Current Copilot JWT token |

> All OpenAI endpoints are also available without the `/v1/` prefix. The Responses API is available at both `/responses` and `/v1/responses`.

## Web Search

The proxy performs real-time web searches using a two-pass architecture:

1. **Pass 1** — Copilot determines what to search (non-streaming call)
2. **Search** — Proxy fetches results from Tavily or Brave (5s timeout, max 5 results)
3. **Pass 2** — Copilot generates a response using the injected search results

Each web search uses 2–3 internal Copilot API calls.

### Setup

**Tavily (Recommended, Free)** — Sign up at [app.tavily.com](https://app.tavily.com), add `TAVILY_API_KEY` to `.env`

**Brave Search** — Sign up at [brave.com/search/api](https://brave.com/search/api/), add `BRAVE_API_KEY` to `.env`

### Trigger Conditions

- **Path 1 (zero-cost):** Client sends a typed Anthropic web search tool (`type: "web_search_20250305"`)
- **Path 2 (preflight):** Client sends a tool with a recognized name and the last user message appears to need real-time info

Recognized names: `web_search`, `internet_search`, `brave_search`, `bing_search`, `google_search`, `find_online`, `internet_research`

## Using with Claude Code

### Interactive Setup

```sh
npx copilot-api@latest start --claude-code
```

Select a primary model and a small/fast model. A ready-to-paste launch command is copied to your clipboard.

### Manual Setup

Create `.claude/settings.json` in your project root:

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://localhost:4141",
    "ANTHROPIC_AUTH_TOKEN": "dummy",
    "ANTHROPIC_MODEL": "gpt-4.1",
    "ANTHROPIC_DEFAULT_SONNET_MODEL": "gpt-4.1",
    "ANTHROPIC_SMALL_FAST_MODEL": "gpt-4.1",
    "ANTHROPIC_DEFAULT_HAIKU_MODEL": "gpt-4.1",
    "DISABLE_NON_ESSENTIAL_MODEL_CALLS": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1"
  },
  "permissions": {
    "deny": ["WebSearch"]
  }
}
```

More options: [Claude Code settings](https://docs.anthropic.com/en/docs/claude-code/settings#environment-variables) · [IDE integrations](https://docs.anthropic.com/en/docs/claude-code/ide-integrations)

## Advanced Features

### Automatic Endpoint Routing

Models declare their `supported_endpoints`. When a model doesn't support `/chat/completions` (e.g. some gpt-5.x variants), the proxy automatically routes through the Responses API with full translation. Claude models go the opposite direction — they're translated from Responses API to Chat Completions.

### Context Overflow Auto-Switch

When estimated token count exceeds the requested model's context window, the proxy auto-switches to the largest available model. This prevents context-window errors without client-side changes.

### Image Handling

- **413 Stripping Cascade:** On payload-too-large errors, the proxy retries by progressively stripping images: older images first → all images → trigger compaction
- **Proactive Trimming:** Set `IMAGE_CONTEXT_TRIMMING_ENABLED=1` to auto-trim processed images beyond a message threshold
- **Validation:** Rejects PNG images smaller than 4×4 pixels

### Large Edit Guidance

When file-edit tools (Edit, Write, MultiEdit) are present and the model's max output is under 32K tokens, the proxy injects a system message warning about output limits — helping models plan chunked edits instead of overflowing.

### Empty Response Recovery

If Copilot returns an empty response (common with some model backends), the proxy retries up to 2 times and falls back to a synthetic response explaining the failure.

### Truncated Tool Call Detection

When a model's output is cut off mid-tool-call, the proxy detects the truncation and returns an explanatory text block with `end_turn` instead of a malformed tool_use block.

### Token Counting & Compaction Scaling

Token counts include overhead estimates for typed tools (bash: 700, text_editor: 700, etc.), custom tools, and attachments. Counts are scaled per model family (Claude ×1.2, Grok ×1.03, others dynamically) to ensure accurate compaction triggers in Claude Code.

## Docker

### Build & Run

```sh
docker build -t copilot-api .

mkdir -p ./copilot-data
docker run -p 4141:4141 -v $(pwd)/copilot-data:/root/.local/share/copilot-api copilot-api
```

### With Environment Variables

```sh
docker run -p 4141:4141 \
  -e GH_TOKEN=your_github_token \
  -e TAVILY_API_KEY=tvly-... \
  copilot-api
```

### Docker Compose

```yaml
version: "3.8"
services:
  copilot-api:
    build: .
    ports:
      - "4141:4141"
    environment:
      - GH_TOKEN=your_github_token_here
      - TAVILY_API_KEY=tvly-your-key-here
    restart: unless-stopped
```

The Docker image features multi-stage builds, a non-root user, health checks, and pinned base images.

## Using with npx

```sh
npx copilot-api@latest start                    # basic
npx copilot-api@latest start --port 8080         # custom port
npx copilot-api@latest start --account-type business  # business plan
npx copilot-api@latest auth                      # auth only
npx copilot-api@latest check-usage               # quota info
npx copilot-api@latest debug --json              # diagnostics
```

## Usage Dashboard

After starting the server, the console displays a URL to the web-based usage dashboard:

```
https://ericc-ch.github.io/copilot-api?endpoint=http://localhost:4141/usage
```

The dashboard shows usage quotas (Chat, Completions, Premium), detailed statistics, and supports custom endpoints via the `?endpoint=` parameter. On Windows, `start.bat` opens it automatically.

## Running from Source

```sh
bun install           # install dependencies
bun run dev           # development (watch mode)
bun run start         # production
bun run build         # compile to dist/
bun run typecheck     # type check
bun run lint:all      # lint all files
bun run knip          # find unused exports/dead code
```

## Tips

- **Rate limiting:** `--rate-limit 30` enforces a 30s gap. Add `--wait` to queue instead of reject. Use `--burst-count` and `--burst-window` for sliding-window limits.
- **Business/Enterprise:** Always pass `--account-type business` or `enterprise` — it changes the Copilot API base URL.
- **Web search cost:** Each search uses 2–3 internal API calls. Monitor your quota.
- **Token persistence:** Stored at `~/.local/share/copilot-api/github_token`. Use `auth` to regenerate.
- **Proxy:** Set `HTTP_PROXY`/`HTTPS_PROXY` and pass `--proxy-env` to route through a corporate proxy.
