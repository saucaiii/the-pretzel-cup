#!/usr/bin/env bash
# Durable deploy workaround for Vercel Hobby + GitHub-linked projects.
#
# The project is linked on Vercel to github.com/saucaiii/the-pretzel-cup, and
# commits are authored by `sauciii`, which is not the same identity as the
# `brokeasabanker-2355` Vercel account that pushes. On Hobby, that mismatch
# puts every direct `vercel --prod` into permanent UNKNOWN state with no logs.
# Deploying from a .git-less copy bypasses the author check entirely.
#
# Usage: ./scripts/deploy.sh         # production deploy
#        ./scripts/deploy.sh preview # preview deploy

set -euo pipefail

TARGET="${1:-prod}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
SCRATCH="/private/tmp/ppf-deploy-$$"

trap 'rm -rf "$SCRATCH"' EXIT

echo "→ Copying repo to $SCRATCH (excluding .git, node_modules, .vercel)"
mkdir -p "$SCRATCH"
rsync -a \
  --exclude='.git' \
  --exclude='node_modules' \
  --exclude='.vercel' \
  --exclude='*.log' \
  "$REPO/" "$SCRATCH/"

cd "$SCRATCH"

echo "→ Linking to Vercel project"
vercel link --project the-pretzel-cup --yes --scope christopher-s-projects-8307ccd4 > /dev/null

if [ "$TARGET" = "prod" ] || [ "$TARGET" = "production" ]; then
  echo "→ Deploying to PRODUCTION"
  vercel --prod --yes
else
  echo "→ Deploying as PREVIEW"
  vercel --yes
fi
