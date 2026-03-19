@echo off
TITLE Copilot API Proxy

echo ================================================
echo  GitHub Copilot API Proxy
echo ================================================
echo.

:: Load environment variables from .env if it exists
if exist .env (
    echo Loading environment from .env...
    for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
        if not "%%A"=="" if not "%%A:~0,1%"=="#" (
            set "%%A=%%B"
        )
    )
    echo.
)

:: Build if dist/ doesn't exist
if not exist dist (
    echo Building project...
    bun run build
    echo.
)

if defined TAVILY_API_KEY (
    echo Web search: enabled ^(Tavily^)
) else if defined BRAVE_API_KEY (
    echo Web search: enabled ^(Brave^)
) else (
    echo Web search: disabled ^(set TAVILY_API_KEY or BRAVE_API_KEY in .env to enable^)
)
echo.

echo Starting server on http://localhost:4141
echo  --rate-limit 15 --wait  ^(queues requests; 15s gap between calls^)
echo.
echo To launch Claude Code, run in a new terminal:
echo   set ANTHROPIC_BASE_URL=http://localhost:4141 ^& set ANTHROPIC_AUTH_TOKEN=dummy ^& set ANTHROPIC_MODEL=claude-opus-4.6 ^& set ANTHROPIC_DEFAULT_SONNET_MODEL=claude-sonnet-4.6 ^& set ANTHROPIC_SMALL_FAST_MODEL=gpt-4o-mini ^& set ANTHROPIC_DEFAULT_HAIKU_MODEL=claude-opus-4.6 ^& set DISABLE_NON_ESSENTIAL_MODEL_CALLS=1 ^& set CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 ^& claude
echo.

start "" "https://ericc-ch.github.io/copilot-api?endpoint=http://localhost:4141/usage"
bun run ./src/main.ts start --rate-limit 15 --wait

pause
