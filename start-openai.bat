@echo off
TITLE Copilot API - OpenAI Proxy (Codex)

echo ================================================
echo  GitHub Copilot API - OpenAI Compatible Proxy
echo  For use with Codex / OpenAI-compatible clients
echo  Port: 1515
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

echo Starting OpenAI-compatible proxy on http://localhost:1515
echo.
echo Codex config (codex.json or ~/.codex/config.json):
echo   {
echo     "model": "gpt-4o",
echo     "provider": "openai",
echo     "providers": {
echo       "openai": {
echo         "name": "openai",
echo         "base_url": "http://localhost:1515/v1",
echo         "env_key": "OPENAI_API_KEY"
echo       }
echo     }
echo   }
echo.
echo Or run Codex with:
echo   set OPENAI_API_KEY=dummy ^& set OPENAI_BASE_URL=http://localhost:1515/v1 ^& codex
echo.
bun run ./src/main.ts start --port 1515 --verbose
pause
