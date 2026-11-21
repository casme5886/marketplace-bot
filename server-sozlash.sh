#!/usr/bin/env bash
# =====================================================================
#  MarketHub botni Ubuntu serverga o'rnatish (bir marta ishga tushiriladi)
#  Ishlatish:  cd ~/marketplace-bot && bash server-sozlash.sh
#  Nima qiladi:
#   1) Node.js 22 va cloudflared o'rnatadi (yo'q bo'lsa)
#   2) Windows'dan ko'chgan node_modules'ni o'chirib, Linux uchun qayta o'rnatadi
#   3) Ilova uchun https tunnelni yoqadi (MINIAPP_TUNNEL=1)
#   4) "markethub" systemd xizmatini yaratadi: kompyuter yonishi bilan o'zi ishga tushadi,
#      bot to'xtasa o'zi qayta yoqiladi
#   5) Uyqu (sleep) rejimini o'chiradi — server doim yoqiq turadi
# =====================================================================
set -euo pipefail
cd "$(dirname "$0")"
DIR="$(pwd)"
USER_NAME="$(id -un)"
say() { printf '\n\033[1;36m%s\033[0m\n' "$*"; }
die() { printf '\n\033[1;31m❌ %s\033[0m\n' "$*"; exit 1; }

[ -f .dev.vars ] || die ".dev.vars topilmadi. Papkani Windows'dan TO'LIQ ko'chiring (yashirin fayllar bilan)."
[ -f scripts/run.mjs ] || die "Noto'g'ri papka: scripts/run.mjs yo'q."
[ -f .local-kv.json ] || echo "⚠️ .local-kv.json yo'q — bot ma'lumotlarsiz (toza) boshlanadi."

say "1/6 📦 Tizim paketlari..."
sudo apt-get update -y
sudo apt-get install -y curl ca-certificates gnupg

NODE_MAJOR=$(node -v 2>/dev/null | sed 's/v\([0-9]*\).*/\1/' || echo 0)
if [ "${NODE_MAJOR:-0}" -lt 20 ]; then
  say "2/6 🟢 Node.js 22 o'rnatilmoqda..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
else
  say "2/6 🟢 Node.js bor: $(node -v)"
fi

if ! command -v cloudflared >/dev/null 2>&1; then
  say "3/6 ☁️ cloudflared o'rnatilmoqda (ilova uchun https manzil)..."
  sudo mkdir -p --mode=0755 /usr/share/keyrings
  curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
  echo "deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main" | sudo tee /etc/apt/sources.list.d/cloudflared.list >/dev/null
  sudo apt-get update -y && sudo apt-get install -y cloudflared
else
  say "3/6 ☁️ cloudflared bor."
fi

say "4/6 📚 Kutubxonalar (Linux uchun qayta o'rnatilmoqda)..."
rm -rf node_modules
npm install --no-audit --no-fund

# .dev.vars: Windows qator oxirlarini tozalash + tunnelni yoqish
sed -i 's/\r$//' .dev.vars
if ! grep -q '^MINIAPP_URL=' .dev.vars && ! grep -q '^MINIAPP_TUNNEL=' .dev.vars; then
  echo "MINIAPP_TUNNEL=1" >> .dev.vars
fi
# Bulutdagi webhook qolgan bo'lsa ham server ishga tushsin (bulut o'chirilgach olib tashlash mumkin)
grep -q '^FORCE_LOCAL=' .dev.vars || echo "FORCE_LOCAL=1" >> .dev.vars

say "5/6 ⚙️ systemd xizmati (markethub) yaratilmoqda..."
sudo tee /etc/systemd/system/markethub.service >/dev/null <<EOF
[Unit]
Description=MarketHub Telegram bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${USER_NAME}
WorkingDirectory=${DIR}
ExecStart=$(command -v node) ${DIR}/scripts/run.mjs
Restart=always
RestartSec=10
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable --now markethub
sudo systemctl restart markethub

say "6/6 😴 Uyqu rejimi o'chirilmoqda (server doim yoqiq turadi)..."
sudo systemctl mask sleep.target suspend.target hibernate.target hybrid-sleep.target >/dev/null 2>&1 || true

sleep 15
say "✅ TAYYOR! Holat:"
sudo systemctl --no-pager --lines=0 status markethub | head -5 || true
echo
journalctl -u markethub -n 25 --no-pager || true
cat <<'TXT'

Foydali buyruqlar:
  Jurnal (jonli):       journalctl -u markethub -f
  Qayta ishga tushirish: sudo systemctl restart markethub
  To'xtatish:            sudo systemctl stop markethub
TXT
