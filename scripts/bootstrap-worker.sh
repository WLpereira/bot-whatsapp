#!/usr/bin/env bash
set -euo pipefail

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "ERRO: defina DATABASE_URL antes de executar."
  echo "Exemplo: DATABASE_URL='postgresql://user:pass@host:5432/db' bash bootstrap-worker.sh"
  exit 1
fi

APP_DIR="${APP_DIR:-/opt/bot-whatsapp}"
REPO_URL="${REPO_URL:-https://github.com/WLpereira/bot-whatsapp.git}"
BRANCH="${BRANCH:-main}"
WORKER_PORT="${WORKER_PORT:-3001}"

export DEBIAN_FRONTEND=noninteractive

apt-get update
apt-get install -y curl git ca-certificates gnupg

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

apt-get install -y \
  libgbm1 libasound2 libatk1.0-0 libcups2 libdbus-1-3 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 \
  libglib2.0-0 libnss3 libatk-bridge2.0-0 libgtk-3-0 libxss1

if [[ ! -d "$APP_DIR/.git" ]]; then
  rm -rf "$APP_DIR"
  git clone --branch "$BRANCH" "$REPO_URL" "$APP_DIR"
else
  git -C "$APP_DIR" fetch origin "$BRANCH"
  git -C "$APP_DIR" checkout "$BRANCH"
  git -C "$APP_DIR" reset --hard "origin/$BRANCH"
fi

cd "$APP_DIR"
npm install --omit=dev
npm install -g pm2

cat >/etc/bot-whatsapp-worker.env <<EOF
APP_ROLE=worker
NODE_ENV=production
WORKER_PORT=$WORKER_PORT
DATABASE_URL=$DATABASE_URL
EOF

cat >/etc/systemd/system/whatsapp-worker.service <<EOF
[Unit]
Description=WhatsApp Worker (bot-whatsapp)
After=network.target

[Service]
Type=simple
WorkingDirectory=$APP_DIR
EnvironmentFile=/etc/bot-whatsapp-worker.env
ExecStart=/usr/bin/npm run start:worker
Restart=always
RestartSec=5
User=root

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable whatsapp-worker
systemctl restart whatsapp-worker
sleep 2
systemctl --no-pager --full status whatsapp-worker || true

echo "\nBootstrap concluido."
echo "Health local: http://127.0.0.1:$WORKER_PORT/healthz"
echo "Teste: curl -fsS http://127.0.0.1:$WORKER_PORT/healthz"
