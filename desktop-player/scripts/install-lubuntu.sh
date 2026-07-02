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

echo
echo "AJRM Marine Audio Player is installed."
echo "Start it with: npm start"
