#!/bin/sh
# POSIX wrapper for fake-dsh.mjs (chmod +x me). Used via DSH_BIN by tests/repro-dsh.mjs;
# the bridge spawns it directly on POSIX, so the executable bit must be set in git.
exec node "$(dirname "$0")/fake-dsh.mjs" "$@"
