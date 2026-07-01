#!/bin/sh
# POSIX wrapper for fake-claude.mjs (chmod +x me). Used via CLAUDE_BIN by probe-claude-abort-fallback.mjs.
exec node "$(dirname "$0")/fake-claude.mjs" "$@"
