@echo off
:: Service-mode startup script for NSSM (no interactive prompts, no browser)

:: Load environment variables from .env if it exists
cd /d "%~dp0"
if exist .env (
    for /f "usebackq tokens=1,* delims==" %%A in (".env") do (
        if not "%%A"=="" if not "%%A:~0,1%"=="#" (
            set "%%A=%%B"
        )
    )
)

:: Use full path to bun since Local System may not have user PATH
set "BUN_EXE=C:\Users\ttbasil\.bun\bin\bun.exe"

:: Pass the github token directly so the app doesn't try interactive OAuth
:: Read the token from the user's token file
set "TOKEN_FILE=C:\Users\ttbasil\.local\share\copilot-api\github_token"
if exist "%TOKEN_FILE%" (
    set /p GITHUB_TOKEN=<"%TOKEN_FILE%"
) else (
    echo ERROR: GitHub token not found at %TOKEN_FILE%
    echo Run "bun run ./src/main.ts auth" interactively first to authenticate.
    exit /b 1
)

:: Start the server with the token passed via CLI flag (no interactive auth needed)
"%BUN_EXE%" run ./src/main.ts start --github-token "%GITHUB_TOKEN%"
