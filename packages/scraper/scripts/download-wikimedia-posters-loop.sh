#!/usr/bin/env bash
set -u

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scraper_root="$(cd "${script_dir}/.." && pwd)"

max_failures="${MAX_FAILURES:-0}"
restart_delay="${RESTART_DELAY:-10}"
success_delay="${SUCCESS_DELAY:-60}"
failure_count=0
run_count=0

echo "download-wikimedia-posters: continuous mode started; press Ctrl-C to stop" >&2

cd "$scraper_root"

while true; do
  run_count="$((run_count + 1))"
  echo "download-wikimedia-posters: run ${run_count} starting" >&2

  node scripts/download-wikimedia-posters.mjs
  status="$?"

  if [ "$status" -eq 0 ]; then
    failure_count=0
    echo "download-wikimedia-posters: run ${run_count} finished; restarting in ${success_delay}s" >&2
    sleep "$success_delay"
    continue
  fi

  failure_count="$((failure_count + 1))"
  if [ "$max_failures" -gt 0 ] && [ "$failure_count" -gt "$max_failures" ]; then
    echo "download-wikimedia-posters: failed ${failure_count} times; stopping" >&2
    exit "$status"
  fi

  echo "download-wikimedia-posters: run ${run_count} exited with ${status}; restarting after failure ${failure_count} in ${restart_delay}s" >&2
  sleep "$restart_delay"
done
