@echo off
setlocal
cd /d "%~dp0"
title CapCut Team - http://127.0.0.1:8788

start "" /min powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 2; Start-Process 'http://127.0.0.1:8788'"
node src/server.js

echo.
echo Server da dung. Nhan phim bat ky de dong cua so.
pause
