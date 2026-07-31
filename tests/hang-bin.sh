#!/bin/sh
# POSIX wrapper for hang-bin.mjs (chmod +x me). Used via *_BIN by probe-doctor-timeout.mjs.
exec node "$(dirname "$0")/hang-bin.mjs" "$@"
