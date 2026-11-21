@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "$ws = New-Object -ComObject WScript.Shell;" ^
  "$s = $ws.CreateShortcut([Environment]::GetFolderPath('Startup') + '\MarketHub bot.lnk');" ^
  "$s.TargetPath = '%~dp0start-bot.bat'; $s.WorkingDirectory = '%~dp0'; $s.WindowStyle = 7; $s.Save();" ^
  "$d = $ws.CreateShortcut([Environment]::GetFolderPath('Desktop') + '\MarketHub bot.lnk');" ^
  "$d.TargetPath = '%~dp0start-bot.bat'; $d.WorkingDirectory = '%~dp0'; $d.Save()"
echo.
echo ✅ Tayyor! Endi:
echo    - kompyuter yonganda bot o'zi ishga tushadi (oyna kichraytirilgan holda);
echo    - ish stolida "MarketHub bot" yorlig'i paydo bo'ldi.
echo O'chirish uchun: autostart-ochirish.bat
pause
