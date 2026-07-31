#!/bin/sh
# POSIX wrapper for fake-omp.mjs (chmod +x me). Used via OMP_BIN by repro-pipebreak.mjs.
exec node "$(dirname "$0")/fake-omp.mjs" "$@"
