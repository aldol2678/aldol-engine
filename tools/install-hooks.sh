#!/bin/sh
# Install the checked-in git hooks into .git/hooks (git does not version hooks itself).
# Run once per clone, from the repo root: sh tools/install-hooks.sh
set -e
ROOT="$(git rev-parse --show-toplevel)"
ln -sf ../../tools/hooks/pre-push "$ROOT/.git/hooks/pre-push"
chmod +x "$ROOT/tools/hooks/pre-push" "$ROOT/tools/install-hooks.sh"
echo "installed: .git/hooks/pre-push -> tools/hooks/pre-push"
