#!/usr/bin/env bash
# From your computer: upload both repositories (committed files only) to the
# server and run deploy.sh there.
#   bilig_back/deploy/push.sh user@203.0.113.5 [remote_dir=~/bilig]
set -euo pipefail
target="${1:?usage: push.sh user@host [remote_dir]}"
remote="${2:-bilig}"
here="$(cd "$(dirname "$0")" && pwd)"
back="$(dirname "$here")"
ft="$(cd "$back/../bilig_ft" && pwd)"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

upload() { # repo dir, name — exactly the committed tree (HEAD); server-side secrets and backups stay
  local repo="$1" name="$2"
  echo "→ $name ($(git -C "$repo" rev-parse --short HEAD))"
  mkdir -p "$tmp/$name"
  git -C "$repo" archive --format=tar HEAD | tar -x -C "$tmp/$name"
  git -C "$repo" rev-parse --short HEAD > "$tmp/$name/.deploy-commit"
  rsync -az --delete --exclude 'deploy/production.env' --exclude 'deploy/backups/' "$tmp/$name/" "$target:$remote/$name/"
}
ssh "$target" "mkdir -p $remote/bilig_back $remote/bilig_ft"
upload "$back" bilig_back
upload "$ft" bilig_ft
ssh -t "$target" "$remote/bilig_back/deploy/deploy.sh"
