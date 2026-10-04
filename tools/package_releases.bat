@echo off
setlocal
where py >nul 2>nul
if errorlevel 1 (
    python "%~dp0package_releases.py" %*
) else (
    py -3 "%~dp0package_releases.py" %*
)
set EXIT_CODE=%ERRORLEVEL%
pause
endlocal & exit /b %EXIT_CODE%
