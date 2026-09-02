@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   Node.js غير مثبّت.
  echo   بيفتح لك الموقع الحين - حمّل النسخة LTS، ثبّتها، وبعدين افتح هذا الملف مرة ثانية.
  echo.
  start "" "https://nodejs.org/ar"
  pause
  exit /b 1
)

if not exist node_modules (
  echo.
  echo   تجهيز لأول مرة... ياخذ دقيقتين تقريباً. لا تسكّر النافذة.
  echo.
  call npm install
  if errorlevel 1 ( echo   فشل التثبيت. & pause & exit /b 1 )
)

node app.js
pause
