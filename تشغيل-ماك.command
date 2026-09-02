#!/bin/bash
cd "$(dirname "$0")" || exit 1
export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"

if ! command -v node >/dev/null 2>&1; then
  echo ""
  echo "  Node.js غير مثبّت."
  echo "  بيفتح لك الموقع الحين — حمّل النسخة LTS، ثبّتها، وبعدين افتح هذا الملف مرة ثانية."
  echo ""
  open "https://nodejs.org/ar"
  read -r -p "  اضغط Enter للإغلاق..."
  exit 1
fi

if [ ! -d node_modules ]; then
  echo ""
  echo "  تجهيز لأول مرة... ياخذ دقيقتين تقريباً. لا تسكّر النافذة."
  echo ""
  npm install || { read -r -p "  فشل التثبيت. اضغط Enter..."; exit 1; }
fi

node app.js
read -r -p "  انتهى. اضغط Enter للإغلاق..."
