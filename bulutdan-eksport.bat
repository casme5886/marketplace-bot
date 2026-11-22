@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo Bulutdagi botga eksport imkoniyati yuklanmoqda (wrangler deploy)...
call npx wrangler deploy
echo.
echo Tayyor. Claude'ga "bo'ldi" deb yozing.
pause
