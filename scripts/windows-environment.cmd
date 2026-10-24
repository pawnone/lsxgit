@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
set "WQ_POWERSHELL=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if exist "%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe" set "WQ_POWERSHELL=%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
"%WQ_POWERSHELL%" -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-environment.ps1"
set "WQ_SETUP_EXIT=%ERRORLEVEL%"
echo.
if not "%WQ_SETUP_EXIT%"=="0" echo Setup failed. Read the message above, then run this CMD again after fixing it.
pause
exit /b %WQ_SETUP_EXIT%
