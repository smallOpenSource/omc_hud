@echo off
setlocal EnableExtensions
REM ============================================================================
REM  setup-powershell7.bat
REM  Re-applies the "make PowerShell 7 the default shell" setup on a Win10/11 PC:
REM    1) Ensure the latest PowerShell 7 (pwsh) is installed  (winget)
REM    2) Set the Windows default terminal application -> Windows Terminal (HKCU)
REM    3) Set the Windows Terminal default profile      -> PowerShell 7
REM
REM  Single self-contained file: the PowerShell logic is embedded after the
REM  #__PSSTART__ marker (cmd never parses past "exit /b"; PowerShell reads it).
REM  Just double-click, or run from cmd:  setup-powershell7.bat
REM  winget may show a UAC prompt when installing/updating PowerShell 7.
REM ============================================================================

echo.
echo === [1/3] Ensuring latest PowerShell 7 (pwsh) via winget ===
where winget >nul 2>nul
if errorlevel 1 (
  echo [!] winget not found. Install "App Installer" from the Microsoft Store, then re-run.
  echo     Skipping install step; will still try to configure defaults.
) else (
  winget list --id Microsoft.PowerShell -e --accept-source-agreements >nul 2>nul
  if errorlevel 1 (
    echo [*] PowerShell 7 not installed - installing...
    winget install --id Microsoft.PowerShell -e --source winget --accept-source-agreements --accept-package-agreements
  ) else (
    echo [*] PowerShell 7 present - checking for updates...
    winget upgrade --id Microsoft.PowerShell -e --source winget --accept-source-agreements --accept-package-agreements
  )
)

echo.
echo === [2/3 + 3/3] Configuring default terminal and Windows Terminal profile ===
set "PSEXE=powershell"
where pwsh >nul 2>nul && set "PSEXE=pwsh"
%PSEXE% -NoProfile -ExecutionPolicy Bypass -Command "$f='%~f0'; $t=[IO.File]::ReadAllText($f); $m='#__PSSTART__'; $i=$t.LastIndexOf($m); if($i -ge 0){ Invoke-Expression $t.Substring($i+$m.Length) } else { Write-Warning 'Embedded PowerShell section not found.' }"

echo.
echo === Done. Open a NEW terminal window and run:  $PSVersionTable.PSVersion ===
echo (The current 5.1 window is unaffected; new windows use PowerShell 7.)
pause
exit /b 0

#__PSSTART__
# ---------- Embedded PowerShell (raw; cmd does not parse below exit /b) ----------
$ErrorActionPreference = 'Stop'
function Info($m){ Write-Host "[*] $m" -ForegroundColor Cyan }

# (2) Default terminal application -> Windows Terminal  (HKCU, no admin needed)
$startup = 'HKCU:\Console\%%Startup'
if (-not (Test-Path $startup)) { New-Item -Path $startup -Force | Out-Null }
Set-ItemProperty -Path $startup -Name DelegationConsole  -Value '{B23D10C0-E52E-411E-9D5B-C09FDF709C7D}'
Set-ItemProperty -Path $startup -Name DelegationTerminal -Value '{2EACA947-7F5F-4CFA-BA87-8F7FBEEFBE69}'
Info 'Default terminal application -> Windows Terminal'

# (3) Windows Terminal default profile -> PowerShell 7
$candidates = @(
  (Join-Path $env:LOCALAPPDATA 'Packages\Microsoft.WindowsTerminal_8wekyb3d8bbwe\LocalState\settings.json'),
  (Join-Path $env:LOCALAPPDATA 'Packages\Microsoft.WindowsTerminalPreview_8wekyb3d8bbwe\LocalState\settings.json'),
  (Join-Path $env:LOCALAPPDATA 'Microsoft\Windows Terminal\settings.json')
)
$wt = $candidates | Where-Object { Test-Path $_ } | Select-Object -First 1
if ($wt) {
  $raw = [IO.File]::ReadAllText($wt)
  $cfg = $raw | ConvertFrom-Json
  $p = $cfg.profiles.list |
        Where-Object { $_.source -eq 'Windows.Terminal.PowershellCore' } |
        Sort-Object @{ Expression = { $_.name -eq 'PowerShell' } } -Descending |
        Select-Object -First 1
  if (-not $p) { $p = $cfg.profiles.list | Where-Object { $_.commandline -match 'pwsh\.exe' } | Select-Object -First 1 }
  if ($p) {
    $guid = $p.guid
    Copy-Item $wt "$wt.bak" -Force
    if ($raw -match '"defaultProfile"\s*:\s*"\{[0-9A-Fa-f-]+\}"') {
      $new = [regex]::Replace($raw, '("defaultProfile"\s*:\s*")\{[0-9A-Fa-f-]+\}(")', ('${1}' + $guid + '${2}'))
    } else {
      $cfg.defaultProfile = $guid
      $new = $cfg | ConvertTo-Json -Depth 32
    }
    [IO.File]::WriteAllText($wt, $new, (New-Object System.Text.UTF8Encoding($false)))
    Info "Windows Terminal default profile -> $($p.name)  $guid"
  } else {
    Write-Warning 'No PowerShell 7 profile in Windows Terminal yet. Open Windows Terminal once, then re-run.'
  }
} else {
  Write-Warning 'Windows Terminal settings.json not found. Open Windows Terminal once, then re-run.'
}

# Report installed pwsh version
try { $v = (& pwsh -NoProfile -Command '$PSVersionTable.PSVersion.ToString()' 2>$null) } catch { $v = '(pwsh not found)' }
Info "pwsh (PowerShell 7) version: $v"
