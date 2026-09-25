@echo off
rem واچ‌داگ دیده‌بان مناقصات — هر ۵ دقیقه توسط Task Scheduler
rem اگر وب‌اپ (پورت 3725) بالا نبود، آن را hidden اجرا می‌کند
setlocal
set WEBAPP=C:\Users\behzad\.zcode\workspace\default\tender-watch-webapp
set LOG=%WEBAPP%\guard.log
set /p RUNNING=<nul 2>nul
curl -s --max-time 5 http://localhost:3725/health -o nul 2>nul
if %errorlevel%==0 exit /b 0
echo %date% %time% DOWN - reviving >> "%LOG%"
powershell -NoProfile -Command "Start-Process -FilePath 'cmd.exe' -ArgumentList '/c','cd /d %WEBAPP% && C:\Users\behzad\AppData\Local\hermes\node\node.exe server.js >> webapp-boot.log 2>&1' -WindowStyle Hidden"
echo %date% %time% REVIVE-ISSUED >> "%LOG%"
endlocal
