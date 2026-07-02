#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is not installed. Install Node.js 20 or later, then run this script again." >&2
  exit 1
fi

if ! command -v npm >/dev/null 2>&1; then
  echo "npm is not installed. Install npm, then run this script again." >&2
  exit 1
fi

node -e '
const major = Number(process.versions.node.split(".")[0])
if (!Number.isFinite(major) || major < 20) {
  console.error(`Node.js ${process.versions.node} is too old. Install Node.js 20 or later.`)
  process.exit(1)
}
'

npm install

chmod +x scripts/run-player.sh

if [ "$(uname -s)" = "Linux" ]; then
  sandbox_helper="node_modules/electron/dist/chrome-sandbox"
  if [ -f "$sandbox_helper" ]; then
    helper_owner="$(stat -c '%u:%g' "$sandbox_helper")"
    helper_mode="$(stat -c '%a' "$sandbox_helper")"
    if [ "$helper_owner" != "0:0" ] || [ "$helper_mode" != "4755" ]; then
      echo
      echo "Configuring Electron Linux sandbox helper. This needs sudo once."
      sudo chown root:root "$sandbox_helper"
      sudo chmod 4755 "$sandbox_helper"
    fi
  fi

  app_dir="$(pwd)"
  icon_path="$(cd .. && pwd)/public/icon-120.png"
  launcher_path="$app_dir/scripts/run-player.sh"
  desktop_file="$HOME/.local/share/applications/ajrm-marine-audio-player.desktop"
  mkdir -p "$(dirname "$desktop_file")"
  cat > "$desktop_file" <<EOF
[Desktop Entry]
Type=Application
Name=AJRM Marine Audio Player
Comment=Play AJRM Marine Audio announcements
Exec=$launcher_path
Icon=$icon_path
Terminal=false
Categories=Audio;Network;
StartupNotify=true
EOF
  chmod +x "$desktop_file"

  desktop_dir=""
  if command -v xdg-user-dir >/dev/null 2>&1; then
    desktop_dir="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
  fi
  if [ -z "$desktop_dir" ]; then
    desktop_dir="$HOME/Desktop"
  fi
  if [ -d "$desktop_dir" ]; then
    cp "$desktop_file" "$desktop_dir/AJRM Marine Audio Player.desktop"
    chmod +x "$desktop_dir/AJRM Marine Audio Player.desktop"
    echo "Desktop launcher created: $desktop_dir/AJRM Marine Audio Player.desktop"
  fi
fi

echo
echo "AJRM Marine Audio Player is installed."
echo "Start it with: npm start"
echo "Or use the AJRM Marine Audio Player launcher from the desktop/app menu."
