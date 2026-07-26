#!/bin/sh
exec node "$(dirname "$0")/fake-omp-stubborn.mjs" "$@"
