@echo off
chcp 65001 >nul
cd /d "%~dp0"
node -e "if (20 > Number(process.versions.node.split('.')[0])) process.exit(1)" >nul 2>nul || (
  echo [Error] Node.js 20 or newer is required.
  pause
  exit /b 1
)
node cli.cjs repair --banner %*
set "EXIT_CODE=%ERRORLEVEL%"
pause
exit /b %EXIT_CODE%
