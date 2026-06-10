#!/usr/bin/env bash
set -e

# Load .env
if [ -f .env ]; then
  export $(grep -v '^#' .env | xargs)
fi

if [ -z "$MAPILLARY_TOKEN" ]; then
  echo "Error: MAPILLARY_TOKEN not set. Add it to .env"
  exit 1
fi

# Build into _dev/ mirroring what GHA does
rm -rf _dev && mkdir _dev
cp index.html style.css app.js _dev/

sed -i.bak "s@YOUR_MAPILLARY_ACCESS_TOKEN@${MAPILLARY_TOKEN}@g" _dev/app.js
sed -i.bak "s@CACHE_BUST@local@g" _dev/index.html
rm -f _dev/*.bak

echo "Serving at http://localhost:8080"
python3 -m http.server 8080 --directory _dev
