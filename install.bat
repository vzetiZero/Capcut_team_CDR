@echo off
setlocal
cd /d "%~dp0"
title CapCut Team - install

echo === Kiem tra Node.js ===
node -v
if errorlevel 1 (
  echo [LOI] Chua cai Node.js. Tai ban 22 tro len tai https://nodejs.org/ roi chay lai.
  pause
  exit /b 1
)

for /f "tokens=1 delims=v." %%a in ('node -v') do set NODE_MAJOR=%%a
if %NODE_MAJOR% LSS 22 (
  echo [LOI] Can Node.js 22 tro len ^(hien tai: %NODE_MAJOR%^).
  pause
  exit /b 1
)

echo.
echo === Cai thu vien npm ===
call npm install --no-audit --no-fund
if errorlevel 1 (
  echo [LOI] npm install that bai.
  pause
  exit /b 1
)

echo.
echo === Tai Chrome for Testing 142 + ChromeDriver ===
call npm run setup:chrome142
if errorlevel 1 (
  echo [LOI] Tai Chrome for Testing that bai. Kiem tra mang roi chay lai.
  pause
  exit /b 1
)

echo.
echo === Hoan tat ===
echo Chay start.bat de mo ung dung.
pause
