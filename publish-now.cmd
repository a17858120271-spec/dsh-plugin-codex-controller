@echo off
rem Double-click this to log in to GitHub and publish the repo.
rem It opens the browser, prints a code, then pushes and invites the co-maintainer.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0publish-now.ps1"
echo.
pause
