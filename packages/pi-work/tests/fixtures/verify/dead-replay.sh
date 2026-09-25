#!/bin/sh
set -eu
marker="$1"
printf 'marker\n' > "$marker"
printf 'signal\n'
