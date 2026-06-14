@echo off
setlocal
REM Apply the custom OMC HUD statusline on Windows (CMD / double-click launcher).
REM Thin launcher: all logic lives in apply-hud.mjs (cross-platform node).
REM %~dp0 is THIS file's folder (with trailing backslash), so it works no matter
REM which directory you run it from -- double-click it, or run from cmd:
REM   hud-installer\apply-hud-windows.cmd

where node >nul 2>nul
if errorlevel 1 (
  echo Error: 'node' was not found in PATH. Install Node.js first ^(https://nodejs.org^).
  goto :end_fail
)

node "%~dp0apply-hud.mjs"
set "rc=%ERRORLEVEL%"

REM Pause only when launched by double-click (so an interactive cmd window
REM doesn't block). When double-clicked, %cmdcmdline% holds this file's path.
echo %cmdcmdline% | find /i "%~nx0" >nul && pause
exit /b %rc%

:end_fail
echo %cmdcmdline% | find /i "%~nx0" >nul && pause
exit /b 1
