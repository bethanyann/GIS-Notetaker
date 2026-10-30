#!/usr/bin/env bash
# One-time setup for GIS-Notetaker on a fresh Google Cloud e2-micro VM (Debian/Ubuntu).
# Run on the VM:  curl -fsSL <raw-url-of-this-file> | bash   or copy it over and  bash gcp-setup.sh
set -euo pipefail

REPO_URL="${REPO_URL:-https://github.com/LetsGetTechnical/GIS-Notetaker.git}"
APP_DIR=/opt/gis-notetaker

echo "==> Adding 1 GB of swap (e2-micro only has 1 GB RAM; npm builds need headroom)"
if ! swapon --show | grep -q /swapfile; then
  sudo fallocate -l 1G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
fi

echo "==> Installing Node.js 22 and git"
if ! command -v node >/dev/null || [[ "$(node -v)" != v22* ]]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
sudo apt-get install -y git

echo "==> Creating service user and fetching code"
id gisbot >/dev/null 2>&1 || sudo useradd --system --create-home --shell /usr/sbin/nologin gisbot
if [ ! -d "$APP_DIR/.git" ]; then
  sudo git clone "$REPO_URL" "$APP_DIR"
fi
sudo chown -R gisbot:gisbot "$APP_DIR"

echo "==> Installing dependencies and building"
cd "$APP_DIR"
sudo -u gisbot npm ci
sudo -u gisbot npm run build
sudo -u gisbot npm prune --omit=dev

if [ ! -f "$APP_DIR/.env" ]; then
  sudo -u gisbot cp .env.example .env
  sudo chmod 600 "$APP_DIR/.env"
  echo
  echo "!! Fill in $APP_DIR/.env (sudo nano $APP_DIR/.env), then run:"
  echo "   cd $APP_DIR && sudo -u gisbot node dist/register-commands.js"
  echo "   sudo systemctl enable --now gis-notetaker"
fi

echo "==> Installing systemd service"
sudo cp deploy/gis-notetaker.service /etc/systemd/system/gis-notetaker.service
sudo systemctl daemon-reload

echo "Done. Logs:  journalctl -u gis-notetaker -f"
