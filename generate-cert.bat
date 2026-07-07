@echo off
setlocal
TITLE Generate self-signed TLS certificate

echo ================================================
echo  Generate self-signed TLS certificate
echo ================================================
echo.

:: --- Configure the names/addresses the cert is valid for ---------------
:: The laptop connecting over HTTPS must reach the proxy using one of these.
:: Edit these if your LAN IP or hostname changes.
set "LAN_IP=192.168.0.105"
set "HOSTNAME=HPE-5CG5083GTB"

:: SAN (Subject Alternative Name) list. A modern HTTPS client validates the
:: server against this list, NOT the CN, so the connecting address MUST appear
:: here. Add more IP:/DNS: entries comma-separated if needed.
set "SAN=IP:%LAN_IP%,IP:127.0.0.1,DNS:%HOSTNAME%,DNS:localhost"

where openssl >nul 2>nul
if errorlevel 1 (
    echo ERROR: openssl not found on PATH.
    echo Install it ^(e.g. "winget install ShiningLight.OpenSSL.Light"^) and retry.
    pause
    exit /b 1
)

if not exist certs mkdir certs

echo Generating 2048-bit key + self-signed cert ^(valid 825 days^)...
echo   Subject CN : %HOSTNAME%
echo   SANs       : %SAN%
echo.

openssl req -x509 -newkey rsa:2048 -sha256 -days 825 -nodes ^
  -keyout certs\server.key -out certs\server.crt ^
  -subj "/CN=%HOSTNAME%" ^
  -addext "subjectAltName=%SAN%" ^
  -addext "basicConstraints=critical,CA:TRUE" ^
  -addext "keyUsage=critical,digitalSignature,keyCertSign"

if errorlevel 1 (
    echo.
    echo ERROR: certificate generation failed.
    pause
    exit /b 1
)

echo.
echo ================================================
echo  Done. Files written to:
echo    certs\server.crt   ^(certificate - copy this to the laptop and trust it^)
echo    certs\server.key   ^(private key - keep on this PC only^)
echo ================================================
echo.
echo Next steps:
echo   1. Copy certs\server.crt to the laptop and install it as a
echo      Trusted Root Certification Authority.
echo   2. Start the proxy with start.bat ^(now HTTPS^).
echo   3. On the laptop, connect to: https://%LAN_IP%:4141
echo.
pause
endlocal
