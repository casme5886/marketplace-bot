@echo off
chcp 65001 >nul
title MarketHub bot
cd /d "%~dp0"

if not exist node_modules (
  echo [MarketHub] Birinchi ishga tushirish: kutubxonalar o'rnatilmoqda...
  call npm install
)
if not exist .dev.vars (
  echo [MarketHub] .dev.vars fayli topilmadi. .dev.vars.example dan nusxa olib, kalitlarni yozing.
  pause
  exit /b 1
)

:loop
node scripts\run.mjs
echo.
echo [MarketHub] Bot to'xtadi. 10 soniyadan keyin qayta ishga tushadi... (butunlay yopish uchun oynani yoping)
timeout /t 10 /nobreak >nul
goto loop
