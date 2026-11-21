@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ============================================
echo   MarketHub botni Cloudflare'ga ko'chirish
echo ============================================
call npm install --no-audit --no-fund
node scripts\cloud-deploy.mjs
if errorlevel 1 (
  echo.
  echo Xato bo'ldi. Yuqoridagi xabarni Claude'ga yuboring.
  pause
  exit /b 1
)
if exist autostart-ochirish.bat call autostart-ochirish.bat
echo.
pause
