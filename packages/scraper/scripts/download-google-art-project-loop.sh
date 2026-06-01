#!/usr/bin/env bash
set -u

max_failures="${MAX_FAILURES:-0}"
restart_delay="${RESTART_DELAY:-10}"
success_delay="${SUCCESS_DELAY:-5}"
empty_delay="${EMPTY_DELAY:-300}"
failure_count=0
run_count=0

echo "download-google-art-project: continuous mode started; press Ctrl-C to stop" >&2

while true; do
  run_count="$((run_count + 1))"
  echo "download-google-art-project: run ${run_count} starting" >&2

  STOP_ON_EMPTY="${STOP_ON_EMPTY:-1}" node scripts/download-google-art-project.mjs
  status="$?"

  if [ "$status" -eq 20 ]; then
    failure_count=0
    echo "download-google-art-project: run ${run_count} added no new items; retrying in ${empty_delay}s" >&2
    sleep "$empty_delay"
    continue
  fi

  if [ "$status" -eq 0 ]; then
    failure_count=0
    echo "download-google-art-project: run ${run_count} finished; restarting in ${success_delay}s" >&2
    sleep "$success_delay"
    continue
  fi

  failure_count="$((failure_count + 1))"
  if [ "$max_failures" -gt 0 ] && [ "$failure_count" -gt "$max_failures" ]; then
    echo "download-google-art-project: failed ${failure_count} times; stopping" >&2
    exit "$status"
  fi

  echo "download-google-art-project: run ${run_count} exited with ${status}; restarting after failure ${failure_count} in ${restart_delay}s" >&2
  sleep "$restart_delay"
done
