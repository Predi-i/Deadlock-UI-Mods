@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0build_mod_strip_comments.ps1" %*
set EXIT_CODE=%ERRORLEVEL%

pause

endlocal & exit /b %EXIT_CODE%
