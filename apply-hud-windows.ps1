# Apply the custom OMC HUD statusline on Windows.
# Thin launcher: all logic lives in apply-hud.mjs (cross-platform node).
# Run from PowerShell:  powershell -ExecutionPolicy Bypass -File .\apply-hud-windows.ps1
#Requires -Version 5
$ErrorActionPreference = "Stop"

$dir = Split-Path -Parent $MyInvocation.MyCommand.Path

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    Write-Error "'node' was not found in PATH. Install Node.js first (https://nodejs.org)."
    exit 1
}

& node (Join-Path $dir "apply-hud.mjs")
exit $LASTEXITCODE
