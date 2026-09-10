# Copilot API

A reverse-engineered proxy exposing **OpenAI** and **Anthropic** compatibility endpoints for GitHub Copilot, including [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview). Hosted tool execution and provider-specific capabilities have the boundaries documented below.

## Features

- **Triple API Compatibility** — OpenAI Chat Completions, OpenAI Responses API, and Anthropic Messages API, all backed by GitHub Copilot
- **Claude Code Integration** — Interactive model selector (`--claude-code`), client tools and toolsets, token counting, and auto-compaction
- **Automatic Endpoint Routing** — Models that only support `/responses` (e.g. gpt-5.4-mini) are transparently routed through the Responses API with bidirectional translation
- **Web Search** — Native GitHub MCP `web_search` with capability discovery, or explicitly configured [Tavily](https://tavily.com)/[Brave Search](https://brave.com/search/api/) alternatives; no silent provider fallback
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
│  → Model Selector → Typed Server Search → Image Validator           │
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
│  │ • Validate complete buffered tool arguments     │    │
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

```text
Messages request with a supported typed web_search declaration
  |
  +-- tool_choice:none --> ordinary completion; no search execution
  |
  v
Shared request preparation and Copilot completion
  |
  +-- no search calls --> return normal answer or client tool calls
  |
  v
Execute requested searches within the per-request max_uses budget
  |
  +-- WEB_SEARCH_PROVIDER=copilot
  |     GitHub MCP initialization -> tools/list -> web_search({query})
  +-- explicit Tavily / Brave configuration
  |
  v
Server tool results + source-link citations + separately labeled AI summary
  |
  +-- client tools also requested --> return them for client execution
  |
  +-- search-only turn --> feed evidence back to Copilot and continue
                          (disable further search when budget is exhausted)
```

Custom tool names never trigger search interception. Streaming requests receive
keepalive pings during orchestration, then the same ordered content as nonstream
responses. Structured-output and compaction requests retain their dedicated
handling; provider failures never select an unrelated fallback service.

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
WEB_SEARCH_PROVIDER=copilot      # Native GitHub MCP search; requires advertised web_search
# WEB_SEARCH_PROVIDER=tavily     # Requires TAVILY_API_KEY
# WEB_SEARCH_PROVIDER=brave      # Requires BRAVE_API_KEY
# WEB_SEARCH_PROVIDER=off        # Disable even when keys are present
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

### nginx / public reverse proxy

If you expose `copilot-api` through nginx, raise nginx's request body limit for the API location. Codex `/v1/responses` turns can include long conversation history, tool output, and images. With nginx's default body limit, nginx returns a raw HTML `413 Request Entity Too Large` before this server receives the request, so the `/v1/responses` handler cannot emit the `response.failed` / `context_length_exceeded` event that Codex uses to auto-compact.

Use the sample in `deploy/nginx/copilot-api.conf.example`, or add the equivalent directive to your `server` or `location` block:

```nginx
client_max_body_size 256m;
```

After changing nginx config, run:

```sh
nginx -t
sudo systemctl reload nginx
```

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
| `/v1/messages` | POST | Anthropic Messages compatibility (see tool execution boundaries below) |
| `/v1/messages/count_tokens` | POST | Token counting with model-specific scaling |

### Utility

| Endpoint | Method | Description |
|---|---|---|
| `/usage` | GET | Copilot quota and usage statistics |
| `/token` | GET | Current Copilot JWT token |

> All OpenAI endpoints are also available without the `/v1/` prefix. The Responses API is available at both `/responses` and `/v1/responses`.

## Web Search

On `/v1/messages`, a typed `web_search` declaration enables a server-side loop:
Copilot proposes queries, the selected provider returns actual sources, and Copilot
synthesizes the answer. Every search produces `server_tool_use` and
`web_search_tool_result` blocks; source excerpts carry citations. Multiple searches
are supported. Outstanding client calls are returned to the client without
fabricating their results. `tool_choice: none` never triggers a search.

Streaming uses a buffered response with periodic SSE pings while search is in
progress. Both modes return the same search evidence, client calls, and errors.
Internal search/synthesis requests incur additional Copilot usage beyond the
incoming-request rate limiter.

### Setup

**Copilot native (no unrelated search API key):** set
`WEB_SEARCH_PROVIDER=copilot` and use the proxy's existing GitHub login. The
official MCP client SDK initializes a Streamable HTTP connection to GitHub's
documented `https://api.githubcopilot.com/mcp/x/all` endpoint using that user's
ordinary bearer token. It follows `tools/list` pagination and requires the
advertised read-only `web_search` tool with its `query` input, then invokes only
`web_search({query})`. The adapter does not expose or invoke the other MCP tools.
Protocol negotiation, session headers, JSON responses, and SSE are handled by
the SDK; requests have a 90-second total deadline and bounded response bodies.

Source links come exclusively from the native result's
`text.annotations[].url_citation`, never from URLs in generated prose or
`bing_searches`. This endpoint supplies **AI synthesis plus source links, not
original source excerpts**. The synthesis is separately labeled
Copilot-generated/unverified and treated as untrusted evidence; source
descriptions and citation `cited_text` remain empty when no excerpt exists.
Do not treat the generated answer as a quotation or authoritative model metadata.

A harmless live adapter query successfully returned an official source link on
September 9, 2026. Availability still depends on the configured login, host, and
organization policy; this does not establish access for a deployed server's
account. Missing tools and malformed result schemas fail visibly. HTTP,
JSON-RPC, and tool-level policy errors are preserved. The legacy `/skills` /
`bing-search` capability is **not** a prerequisite: an account may advertise
native MCP search without that older skill.

No token, entitlement, privileged-header, confirmation, or account-switching
bypass is attempted. Selecting Copilot never falls back to third parties, even
if their keys exist, and never blindly forwards a search tool type to
`/chat/completions` or `/responses`.

**Explicit alternatives:** set `WEB_SEARCH_PROVIDER=tavily` with `TAVILY_API_KEY`,
or `WEB_SEARCH_PROVIDER=brave` with `BRAVE_API_KEY`. With no provider selector,
existing configured-key behavior is preserved (Tavily first, then Brave).
`WEB_SEARCH_PROVIDER=off` disables search.

```json
{
  "type": "web_search_20260318",
  "name": "web_search",
  "allowed_callers": ["direct"],
  "max_uses": 5
}
```

Supported versions: `web_search_20250305`, `_20260209`, `_20260318`. Newer versions
default to Anthropic sandbox filtering, so explicitly select `allowed_callers:
["direct"]`; sandbox execution is not emulated. `max_uses` is a per-request budget
from 0 to 20, default 5. Excess calls return `max_uses_exceeded`. Domain filters,
user location, dynamic filtering, and response-inclusion controls are currently
rejected rather than silently ignored. Custom tools named `WebSearch`,
`web_search`, or `internet_research` remain client-executed custom tools, without
keyword preflight or interception on the Messages endpoint.

Search references use bounded, process-local `copilot-search:v1:` opaque handles
in the compatibility `encrypted_content`/`encrypted_index` fields. They are **not
Anthropic ciphertext, encryption, or portable Anthropic replay data**. Replayed
handles restore source metadata and any available excerpts; native MCP results
have no original excerpts. Unknown/expired handles fail explicitly. Restarting
the proxy or eviction beyond 2,000 sources / 8MB total expires them. Recovery may
require starting a new conversation or removing the expired search blocks before
searching again; resending the same rejected history will not repair its handles.
Individual replay records over 64KB fail explicitly.
Retrieved content is untrusted evidence, not instructions.

Native protocol sources (reviewed September 9, 2026):
[GitHub remote MCP server and documented toolset URLs](https://github.com/github/github-mcp-server/blob/main/docs/remote-server.md),
[MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports),
and the [official TypeScript SDK client](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.x/docs/client.md).
The exact `web_search` capability and answer/citation schema were also confirmed
through ordinary authenticated discovery and one harmless native query.

## Concurrent requests and shared admission limits

Inference routes handle independent HTTP requests asynchronously. A slow JSON
response or SSE stream does not hold a server-wide completion lock: another
request can enter upstream and finish while the first remains active. Tool
schemas, call IDs, name mappings and streamed argument buffers are request-local.
This is separate from multiple tool calls inside a single model response.

Optional interval and burst limits gate **request starts**, not response
lifetimes. Waiting requests recheck shared account capacity atomically after
waking; interval and burst reservations happen together. `--rate-limit` accepts
finite non-negative seconds. Without `--wait`, an interval rejection returns
HTTP 429 with `Retry-After`; burst limits retain their waiting behavior.
Canceled waiting requests consume no admission slot. Cancellation propagates to
active completion transports/body readers and native Copilot search; SSE
disconnects stop their request's keepalive timers. A canceled request cannot
trigger a subsequent model retry. A connected client observing cancellation may
receive HTTP 499 before response headers have been committed.

No limit means no proxy admission delay, **not unlimited upstream capacity**.
All clients of one proxy process share its configured GitHub/Copilot identity,
account quota and upstream policy. Model-scoped burst limits are optional
operator settings, not per-user account isolation. A public unauthenticated
deployment is not a multi-tenant authentication system; this behavior adds
neither client authentication nor account pooling. Embeddings retain their
existing admission behavior and also propagate client cancellation.

A `Write` error such as `required at $` means generated input is missing a
required root property of that request's schema. It does not identify which
property, prove request mixing, or establish why generation took a long time.
Request-log duration includes request processing and upstream wait, not just
admission. Validation remains strict: invalid executable tool arguments are not
committed or fabricated. The narrowly gated `Write` correction below applies
only to one known missing-`content` shape; `Bash` and every other executable
tool retain strict validation without regeneration.

## Anthropic tool compatibility

| Capability | Behavior and execution boundary |
|---|---|
| Custom tools, including Workflow and client MCP tools | Client executes. Entire JSON Schema is retained, including unions, required fields, extra properties, and local references. Missing/`null`/`custom` type accepted. |
| Workflow selectors | Preserve supplied constraints. For older unrefined schemas, require one of the actually declared `script`, `name`, `scriptPath`, or `runId` selectors. No fabricated script or selector values. |
| ToolSearch `tool_reference` and `defer_loading` | Client discovery references remain visible; definitions supplied in `tools` are made available eagerly. Hosted discovery is not emulated. |
| Browser/computer `*_toolset_20260801` | Expand enabled member schemas with collision-safe aliases; return original `name` + `toolset_name`. Client executes actions. Browser state and member order survive history translation. Enabled members must use uniform deferral; deferred toolsets cannot carry cache controls. |
| Typed bash, editor, memory clients | Convert documented client schemas to functions; execution remains in the client. See accepted exact versions in `client-tool-catalog.ts`. |
| Legacy computer `20250124` / `20251124` | Preserve client-executed `action` inputs and display configuration. Zoom is available only with `20251124` and `enable_zoom: true`; new toolset-only `key.repeat` is not advertised. |
| `strict`, input examples, parallel control | Strict flag forwarded and generated input validated locally; examples adapted into descriptions. `disable_parallel_tool_use` maps to `parallel_tool_calls`. No upstream strict-generation guarantee is claimed. |
| `eager_input_streaming`, caching | Executable inputs buffered until complete and valid, regardless of eager flag. Cache controls do not guarantee Anthropic caching/billing behavior. |
| Web search | Server-executed adapter described above, actual sources only. |
| Anthropic web fetch, code execution, advisor, hosted tool search, remote `mcp_toolset` | Explicit unsupported-capability error. Passing a schema cannot provision Anthropic's sandbox, remote executor, or advisor. |
| Programmatic `allowed_callers`, container, remote `mcp_servers`, context-management execution | Explicit unsupported-capability error; use direct, client-managed tools/state. |

Tool argument JSON must be an object conforming to the declared schema. A genuine
parameterless `{}` remains valid. Empty bytes, malformed/truncated JSON,
non-objects, and unrecovered schema-invalid output produce explicit upstream
errors, never a success-shaped `{}`. Partial, interleaved Chat/Responses arguments
are assembled
by call identity before tool blocks are committed. A stream that ends before its
completion signal cannot commit executable calls.

JSON Schema draft-07, 2019-09, and 2020-12 local references are validated without
coercion or default insertion. Invalid/unsupported schemas fail as request errors;
remote schemas are not fetched. Tool names are request-scoped and reversible, so
custom `screenshot`, `browser.screenshot`, and `computer.screenshot` cannot collide.

### Optional Write missing-content recovery

`WRITE_TOOL_RECOVERY=1` enables one model-only correction for a nonstreaming,
complete, sole custom unscoped `Write` call that is missing only the required
root `content` field. It is **off by default**; `0` disables it and any other
value fails startup. The supplied `file_path` must already be a valid nonempty
string, and the request must use a conservative flat schema that directly
declares required string `file_path` and `content` properties. References,
unions, conditionals, nested schemas, malformed arguments, unknown properties,
other missing requirements, invalid existing values, mixed calls, prose,
refusals, policy errors, and truncated turns are not corrected.

Enabling the flag routes an otherwise eligible nonstreaming request that
declares this flat `Write` tool through the existing one-shot output-tool
transport for its initial completion, even when the model does not call
`Write`. That initial completion therefore does not use the normal completion
transport's transient HTTP retries. A valid response or a response without a
`Write` call is returned without the additional correction request.

The one additional request uses the original model, conversation, and unchanged
schema, exposes only the original `Write` tool, and uses `tool_choice: auto`.
Existing arguments are sent back to the same model as explicitly untrusted data
to preserve, never logged by the recovery path, and must remain deeply
identical. The final arguments still have to validate against the full original
schema. A valid correction retains the original call ID and sums both calls'
usage; any changed value, extra action, wrong identity/model, invalid output,
timeout, or disconnect fails without another attempt or a client-visible tool.

Correction permits at most one extra model call and 20 seconds of wall time,
including response-body reading. It does not use nested transport, image, or
empty-response retries. Streaming `Write` requests keep the existing strict SSE
behavior and are never buffered for this feature. The proxy only validates and
returns tool input: it never executes `Write`, changes caller permissions, or
assumes execution authority. Nonstreaming schema-mismatch diagnostics report
only fixed-name booleans, JSON type labels, a controlled finish reason, and
bounded property counts—never paths, contents, values, lengths, hashes,
arbitrary property names, schemas, or AJV parameters. Streaming keeps its
existing strict error path without this additional metadata. This is a guarded
mitigation for the standard missing-`content` case, not a guarantee to repair
every `Write` failure or evidence about a historical payload whose exact
arguments were not retained.

### Optional ToolSearch argument recovery

`TOOL_SEARCH_RECOVERY=1` enables one model-only argument regeneration for a
complete, sole custom unscoped `ToolSearch` call whose arguments are a JSON
object but fail the client's declared `input_schema`. It is **off by default**;
`0` disables it and any other value fails startup. The client schema is
authoritative and remains unchanged, including local references, unions, and
constraints. Hosted tools such as `type: tool_search_tool_*` are different and
are not enabled or emulated by this setting.

Every property already supplied by the model must remain deeply identical. The
same selected model receives the original conversation, the unchanged
`ToolSearch` schema, and only that tool with `tool_choice: auto`; it may add
only schema-supported arguments needed to express the original discovery
intent. A valid regeneration retains the original call ID, preserves any
original explanatory text, and sums both calls' usage. The proxy never executes
`ToolSearch`, invents tool references or results, or calls a discovered tool.
Malformed or truncated JSON, refusals, policy errors, mixed tool calls,
previously acknowledged call IDs, changed existing values, and a second invalid
result fail without another attempt.

Eligible JSON and SSE requests are buffered through the one-shot output-tool
transport so invalid discovery arguments are never partially emitted. While
buffered, SSE connections receive keepalive events; the final response contains
one normal message event sequence. This means the initial completion does not
use the normal streaming transport or its transient HTTP retries. A valid
`ToolSearch` call or a response without `ToolSearch` makes no additional model
request. Regeneration permits at most one extra same-model call and 20 seconds,
including response-body reading, and request cancellation propagates through
both calls. Request and response payload values are omitted from debug logs on
routes declaring logical `ToolSearch`. This is bounded compatibility for
schema-invalid discovery calls, not a guarantee that every provider output can
be repaired.

### Optional StructuredOutput recovery

`STRUCTURED_OUTPUT_RECOVERY=1` (or `true`) enables one schema-aware regeneration
for the custom, unscoped `StructuredOutput` output-format tool. It is **off by
default** (`0` / `false` also disable it); other values fail startup. Enable this
only when clients use that name exclusively for final output, not an executable
action. A name alone does not establish output-only semantics.

Recovery requires a complete turn containing exactly one `StructuredOutput` call
whose arguments are a valid JSON object but fail its declared schema. Additional
calls, assistant prose, malformed or truncated arguments, refusals, content
filters, policy/authentication errors, and invalid schemas are not recoverable.
Typed/server tools, compaction, `output_config.format`, `tool_choice: none`, and
forced choices of a different tool retain their existing paths. Ordinary
executable tools such as Workflow and Bash are never regenerated by this feature.

The additional request uses the same model, original conversation and unchanged
schema, with only `StructuredOutput` available and `tool_choice: auto` (including
Fable 5.1). The invalid candidate is discarded, not replayed as instructions.
Nothing is executed; no fields are coerced, invented, deleted, or defaulted.
Only a valid same-identity result is committed, retaining the original call ID
and summing usage from both generations.

Eligible requests are buffered upstream as nonstreaming responses before emitting
JSON or downstream SSE tool blocks. SSE keepalive pings continue while waiting;
no partial tool block or success terminal is emitted before validation. The
initial buffered request has a five-minute overall deadline; existing image
preparation still applies. Regeneration permits **at most one additional model
call and 20 seconds of additional wall time**, including response-body reading.
It bypasses ordinary transport/image/empty-response retries. The deadline does
not reset on traffic, and client disconnects abort transport/body consumption
and stop keepalives. Valid output incurs no extra model call.

Schema failures report at most five validation keywords and masked structural
depths. Property names, schema paths, enum/const values, raw AJV errors, and
candidate payloads are not exposed in these diagnostics. The recovery path also
suppresses request/response debug payload dumps. A failed or timed-out recovery
returns an explicit error; it is not a promise to repair every StructuredOutput
failure. This follows the bounded re-prompting approach described by the
[Claude Agent SDK structured-output documentation](https://code.claude.com/docs/en/agent-sdk/structured-outputs),
without claiming Anthropic-native execution or an upstream strict-output guarantee.

Primary Anthropic references:
[tool reference](https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-reference),
[define tools](https://platform.claude.com/docs/en/agents-and-tools/tool-use/define-tools),
[browser](https://platform.claude.com/docs/en/agents-and-tools/tool-use/browser-use-tool),
[computer](https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool),
[memory](https://platform.claude.com/docs/en/agents-and-tools/tool-use/memory-tool),
[editor](https://platform.claude.com/docs/en/agents-and-tools/tool-use/text-editor-tool),
[streaming](https://platform.claude.com/docs/en/agents-and-tools/tool-use/fine-grained-tool-streaming),
[web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool).

### Claude Fable model metadata

Fable 5 (`claude-fable-5`, `claude-fable-5.0`, `claude-fable-5-0`) and Fable 5.1
(`claude-fable-5-1` / `claude-fable-5.1`) share catalog-aware alias normalization
across discovery, token counting, and inference. Exact catalog IDs take priority;
the zero-minor alias is anchored to Fable 5, not guessed for unrelated models.
They use exact 1,000,000-token context and 128,000-token output metadata only when cached metadata
is missing. The real Copilot catalog ID and limits always win. Known-family cache
misses estimate actual request tokens rather than returning a synthetic 200,000
tokens to force compaction; unrelated unknown models are not assigned 1M context.
This estimation fallback does not grant upstream model access or add catalog entries.
Fable 5.1 does not support forced `tool_choice: any/tool`; requests receive a clear
error instead of silently changing model or tool mode.
Sources: [Fable 5](https://platform.claude.com/docs/en/models/fable-5/overview),
[Fable 5.1](https://platform.claude.com/docs/en/models/fable-5-1/overview).

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

### Ultra Reasoning Effort

On the OpenAI endpoints, `reasoning.effort: "ultra"` (Responses) and `reasoning_effort: "ultra"` (Chat Completions) are case-insensitive aliases for the target model's highest supported reasoning effort. Normalization happens **before the first upstream request**, for both streaming and non-streaming requests and in either translation direction. For example, `gpt-6-astra` with `"Ultra"` is sent upstream with `"max"`.

The proxy first uses the raw upstream catalog's `capabilities.supports.reasoning_effort` list, ranked `none < minimal < low < medium < high < xhigh < max`, not the list's ordering. This field is defined in the [Copilot client's model capability schema](https://github.com/microsoft/vscode-copilot-chat/blob/main/src/platform/endpoint/common/endpointProvider.ts); the proxy's public `/v1/models` response does not expose it. When the field is absent, these exact, verified model defaults apply:

| Maximum effort | Models |
|---|---|
| `max` | `gpt-6-astra`, `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna` |
| `xhigh` | `gpt-5.5`, `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.4-2026-03-05` |
| `high` | `gpt-5-mini`, `gpt-5-mini-2025-08-07` |

Explicit catalog metadata takes precedence over these defaults. A non-chat model, an empty or `none`-only effort list, an unrecognized/malformed effort list, or a model with neither effort metadata nor a verified maximum produces HTTP 400 (`invalid_request_error`) before dispatch. The proxy does not guess capabilities from a model-family prefix.

Ultra is not a new upstream value, an error-triggered fallback, or agent delegation. It does not change model identity, context limits, the client catalog, or Anthropic thinking behavior. Other effort values and omitted effort remain unchanged, and other `reasoning` fields are preserved. Effort validation errors are forwarded without trying a different effort; the existing context-overflow model selection remains separate, with normalization using its final target.

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
