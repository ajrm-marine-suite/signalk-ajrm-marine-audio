#!/usr/bin/env bash
# Launches AJRM Marine Audio with the expected local runtime environment.

set -euo pipefail

cd "$(dirname "$0")/.."
exec npm start
