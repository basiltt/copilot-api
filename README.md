# Copilot API Proxy

> [!WARNING]
> This is a reverse-engineered proxy of GitHub Copilot API. It is not supported by GitHub, and may break unexpectedly. Use at your own risk.

> [!WARNING]
> **GitHub Security Notice:**
> Excessive automated or scripted use of Copilot (including rapid or bulk requests, such as via automated tools) may trigger GitHub's abuse-detection systems.
> You may receive a warning from GitHub Security, and further anomalous activity could result in temporary suspension of your Copilot access.
>
> GitHub prohibits use of their servers for excessive automated bulk activity or any activity that places undue burden on their infrastructure.
>
> Please review:
>
> - [GitHub Acceptable Use Policies](https://docs.github.com/site-policy/acceptable-use-policies/github-acceptable-use-policies#4-spam-and-inauthentic-activity-on-github)
> - [GitHub Copilot Terms](https://docs.github.com/site-policy/github-terms/github-terms-for-additional-products-and-features#github-copilot)
>
> Use this proxy responsibly to avoid account restrictions.

[![ko-fi](https://ko-fi.com/img/githubbutton_sm.svg)](https://ko-fi.com/E1E519XS7W)

---

**Note:** If you are using [opencode](https://github.com/sst/opencode), you do not need this project. Opencode supports GitHub Copilot provider out of the box.

---

## Project Overview

A reverse-engineered proxy for the GitHub Copilot API that exposes it as an OpenAI and Anthropic compatible service. This allows you to use GitHub Copilot with any tool that supports the OpenAI Chat Completions API or the Anthropic Messages API, including to power [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview).

## Features

- **OpenAI & Anthropic Compatibility**: Exposes GitHub Copilot as an OpenAI-compatible (`/v1/chat/completions`, `/v1/models`, `/v1/embeddings`) and Anthropic-compatible (`/v1/messages`) API.
- **Claude Code Integration**: Easily configure and launch [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview) to use Copilot as its backend with a simple command-line flag (`--claude-code`).
- **Web Search**: Optional real-time web search via [Tavily](https://tavily.com) (preferred) or [Brave Search](https://brave.com/search/api/). When enabled, the proxy intercepts web search tool calls, fetches live results, and injects them into the model's context automatically.
- **Usage Dashboard**: A web-based dashboard to monitor your Copilot API usage, view quotas, and see detailed statistics.
- **Rate Limit Control**: Manage API usage with rate-limiting options (`--rate-limit`) and a waiting mechanism (`--wait`) to prevent errors from rapid requests.
- **Manual Request Approval**: Manually approve or deny each API request for fine-grained control over usage (`--manual`).
- **Token Visibility**: Option to display GitHub and Copilot tokens during authentication and refresh for debugging (`--show-token`).
- **Flexible Authentication**: Authenticate interactively or provide a GitHub token directly, suitable for CI/CD environments.
- **Support for Different Account Types**: Works with individual, business, and enterprise GitHub Copilot plans.

## Demo

https://github.com/user-attachments/assets/7654b383-669d-4eb9-b23c-06d7aefee8c5

## Prerequisites

- Bun (>= 1.2.x)
- GitHub account with Copilot subscription (individual, business, or enterprise)

## Installation

To install dependencies, run:

```sh
bun install
```

## Quick Start (Windows)

The included `start.bat` handles everything automatically:

1. Create a `.env` file in the project root (see [Environment Variables](#environment-variables))
2. Double-click `start.bat` or run it from a terminal

The script will:
- Load environment variables from `.env`
- Build the project if `dist/` doesn't exist
- Show which web search provider is active (if any)
- Start the server in production mode
- Open the Usage Viewer in your browser automatically

## Environment Variables

Create a `.env` file in the project root to configure optional features. The file is gitignored and will never be committed.

```env
# Web Search (optional — pick one)
TAVILY_API_KEY=tvly-...          # Preferred: free at tavily.com (1,000 req/mo, no CC)
BRAVE_API_KEY=BSA...             # Alternative: brave.com/search/api

# Proxy (optional)
HTTP_PROXY=http://proxy:8080
HTTPS_PROXY=http://proxy:8080
```

> **Provider priority:** If both `TAVILY_API_KEY` and `BRAVE_API_KEY` are set, Tavily is used.

## Web Search Setup

The proxy can perform real-time web searches when clients request it. This uses a two-pass flow: the first Copilot call decides what to search, the proxy fetches results from the search API, then the second Copilot call synthesises a final answer using those results.

> **Note:** Each web search request uses 2–3 internal Copilot API calls. These are not counted against the proxy's own rate limiter.

### Option A — Tavily (Recommended, Free)

1. Sign up at [app.tavily.com](https://app.tavily.com) — no credit card required
2. Copy your API key
3. Add to `.env`:
   ```env
   TAVILY_API_KEY=tvly-your-key-here
   ```

**Free tier:** 1,000 requests/month, renews monthly.

### Option B — Brave Search

1. Sign up at [brave.com/search/api](https://brave.com/search/api/)
2. Copy your API key
3. Add to `.env`:
   ```env
   BRAVE_API_KEY=BSA-your-key-here
   ```

### How Web Search Is Triggered

The proxy intercepts web search tool calls automatically. A request triggers the web search flow when:

- **Path 1 (zero-cost):** The client sends a typed Anthropic web search tool (e.g. `type: "web_search_20250305"`)
- **Path 2 (preflight):** The client sends a custom tool whose name is one of the recognised web search names AND the last user message appears to require real-time information

Recognised tool names: `web_search`, `internet_search`, `brave_search`, `bing_search`, `google_search`, `find_online`, `internet_research`

## Using with Docker

Build image

```sh
docker build -t copilot-api .
```

Run the container

```sh
# Create a directory on your host to persist the GitHub token and related data
mkdir -p ./copilot-data

# Run the container with a bind mount to persist the token
# This ensures your authentication survives container restarts
docker run -p 4141:4141 -v $(pwd)/copilot-data:/root/.local/share/copilot-api copilot-api
```

> **Note:**
> The GitHub token and related data will be stored in `copilot-data` on your host. This is mapped to `/root/.local/share/copilot-api` inside the container, ensuring persistence across restarts.

### Docker with Environment Variables

You can pass the GitHub token directly to the container using environment variables:

```sh
# Build with GitHub token
docker build --build-arg GH_TOKEN=your_github_token_here -t copilot-api .

# Run with GitHub token
docker run -p 4141:4141 -e GH_TOKEN=your_github_token_here copilot-api

# Run with Tavily web search enabled
docker run -p 4141:4141 -e GH_TOKEN=your_token -e TAVILY_API_KEY=tvly-... copilot-api
```

### Docker Compose Example

```yaml
version: "3.8"
services:
  copilot-api:
    build: .
    ports:
      - "4141:4141"
    environment:
      - GH_TOKEN=your_github_token_here
      - TAVILY_API_KEY=tvly-your-key-here   # optional
    restart: unless-stopped
```

The Docker image includes:

- Multi-stage build for optimized image size
- Non-root user for enhanced security
- Health check for container monitoring
- Pinned base image version for reproducible builds

## Using with npx

You can run the project directly using npx:

```sh
npx copilot-api@latest start
```

With options:

```sh
npx copilot-api@latest start --port 8080
```

For authentication only:

```sh
npx copilot-api@latest auth
```

## Command Structure

Copilot API uses a subcommand structure with these main commands:

- `start`: Start the Copilot API server. This command will also handle authentication if needed.
- `auth`: Run GitHub authentication flow without starting the server. Typically used to generate a token for use with `--github-token`, especially in non-interactive environments.
- `check-usage`: Show your current GitHub Copilot usage and quota information directly in the terminal (no server required).
- `debug`: Display diagnostic information including version, runtime details, file paths, and authentication status. Useful for troubleshooting and support.

## Command Line Options

### Start Command Options

| Option           | Description                                                                   | Default      | Alias |
| ---------------- | ----------------------------------------------------------------------------- | ------------ | ----- |
| `--port`         | Port to listen on                                                             | `4141`       | `-p`  |
| `--verbose`      | Enable verbose logging                                                        | `false`      | `-v`  |
| `--account-type` | Account type to use (`individual`, `business`, `enterprise`)                  | `individual` | `-a`  |
| `--manual`       | Enable manual request approval                                                | `false`      | —     |
| `--rate-limit`   | Rate limit in seconds between requests                                        | none         | `-r`  |
| `--wait`         | Wait instead of error when rate limit is hit                                  | `false`      | `-w`  |
| `--github-token` | Provide GitHub token directly (must be generated using the `auth` subcommand) | none         | `-g`  |
| `--claude-code`  | Generate a command to launch Claude Code with Copilot API config              | `false`      | `-c`  |
| `--show-token`   | Show GitHub and Copilot tokens on fetch and refresh                           | `false`      | —     |
| `--proxy-env`    | Initialize proxy from environment variables                                   | `false`      | —     |

### Auth Command Options

| Option         | Description               | Default | Alias |
| -------------- | ------------------------- | ------- | ----- |
| `--verbose`    | Enable verbose logging    | `false` | `-v`  |
| `--show-token` | Show GitHub token on auth | `false` | —     |

### Debug Command Options

| Option   | Description               | Default | Alias |
| -------- | ------------------------- | ------- | ----- |
| `--json` | Output debug info as JSON | `false` | —     |

## API Endpoints

### OpenAI Compatible Endpoints

| Endpoint                    | Method | Description                                               |
| --------------------------- | ------ | --------------------------------------------------------- |
| `POST /v1/chat/completions` | POST   | Creates a model response for the given chat conversation. |
| `GET /v1/models`            | GET    | Lists the currently available models.                     |
| `POST /v1/embeddings`       | POST   | Creates an embedding vector representing the input text.  |

### Anthropic Compatible Endpoints

| Endpoint                         | Method | Description                                                  |
| -------------------------------- | ------ | ------------------------------------------------------------ |
| `POST /v1/messages`              | POST   | Creates a model response for a given conversation.           |
| `POST /v1/messages/count_tokens` | POST   | Calculates the number of tokens for a given set of messages. |

### Usage Monitoring Endpoints

| Endpoint     | Method | Description                                                  |
| ------------ | ------ | ------------------------------------------------------------ |
| `GET /usage` | GET    | Get detailed Copilot usage statistics and quota information. |
| `GET /token` | GET    | Get the current Copilot token being used by the API.         |

## Example Usage

```sh
# Basic usage
npx copilot-api@latest start

# Run on custom port with verbose logging
npx copilot-api@latest start --port 8080 --verbose

# Business or enterprise Copilot plan
npx copilot-api@latest start --account-type business
npx copilot-api@latest start --account-type enterprise

# Enable manual approval for each request
npx copilot-api@latest start --manual

# Set rate limit to 30 seconds between requests
npx copilot-api@latest start --rate-limit 30

# Wait instead of error when rate limit is hit
npx copilot-api@latest start --rate-limit 30 --wait

# Provide GitHub token directly (no interactive auth)
npx copilot-api@latest start --github-token ghp_YOUR_TOKEN_HERE

# Interactive Claude Code setup
npx copilot-api@latest start --claude-code

# Auth only (generates token for later use)
npx copilot-api@latest auth

# Show Copilot usage/quota
npx copilot-api@latest check-usage

# Troubleshooting info
npx copilot-api@latest debug --json

# Use system proxy settings
npx copilot-api@latest start --proxy-env
```

## Using the Usage Viewer

After starting the server, a URL to the Copilot Usage Dashboard will be displayed in your console. This dashboard is a web interface for monitoring your API usage.

1. Start the server:
   ```sh
   npx copilot-api@latest start
   ```
2. Open the URL shown in the console (or click it if your terminal supports it):
   `https://ericc-ch.github.io/copilot-api?endpoint=http://localhost:4141/usage`
   - On Windows, `start.bat` opens this page automatically.

The dashboard shows:
- **Usage Quotas** — progress bars for Chat and Completions quota
- **Detailed Statistics** — full JSON breakdown of all usage data
- **URL-based config** — point the dashboard at any compatible endpoint via the `?endpoint=` query parameter

## Using with Claude Code

There are two ways to configure Claude Code to use this proxy:

### Interactive Setup (`--claude-code` flag)

```sh
npx copilot-api@latest start --claude-code
```

You will be prompted to select a primary model and a small/fast model for background tasks. A ready-to-run command will be copied to your clipboard. Paste it in a new terminal to launch Claude Code.

### Manual Setup (`settings.json`)

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

## Running from Source

```sh
# Install dependencies
bun install

# Development (watch mode — auto-restarts on changes)
bun run dev

# Production
bun run start

# Build to dist/
bun run build

# Type check
bun run typecheck

# Lint all files
bun run lint:all

# Find unused exports / dead code
bun run knip
```

## Usage Tips

- **Rate limiting:** Use `--rate-limit <seconds>` to enforce a minimum gap between requests. Add `--wait` to queue requests instead of rejecting them.
- **Business/Enterprise plans:** Always pass `--account-type business` or `--account-type enterprise` if your GitHub account is on one of those plans — it changes the Copilot API base URL.
- **Web search:** Each web search uses 2–3 internal Copilot API calls. If you're on a tight quota, consider only enabling it when needed.
- **Token persistence:** The GitHub token is stored at `~/.local/share/copilot-api/github_token` and reused across sessions. Use `auth` to regenerate it if it expires.
