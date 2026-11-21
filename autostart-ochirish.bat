@echo off
chcp 65001 >nul
powershell -NoProfile -Command "Remove-Item -ErrorAction SilentlyContinue ([Environment]::GetFolderPath('Startup') + '\MarketHub bot.lnk')"
echo ✅ Avtomatik ishga tushish o'chirildi (ish stolidagi yorliq qoladi).
pause
