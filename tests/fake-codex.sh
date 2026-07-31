#!/bin/sh
# POSIX wrapper for fake-codex.mjs (chmod +x me). Used via CODEX_BIN by repro-schema.mjs.
exec node "$(dirname "$0")/fake-codex.mjs" "$@"
