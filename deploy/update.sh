#!/usr/bin/env bash
# Pull the latest code on the Google Cloud VM, rebuild and restart.
set -euo pipefail
cd /opt/gis-notetaker
sudo -u gisbot git pull --ff-only
sudo -u gisbot npm ci
sudo -u gisbot npm run build
sudo -u gisbot npm prune --omit=dev
sudo -u gisbot node dist/register-commands.js
sudo systemctl restart gis-notetaker
echo "Updated. Logs:  journalctl -u gis-notetaker -f"
