#!/usr/bin/env bash
set -u

node_bin="${NODE_BIN:-node}"
query="${QUERY:-paintings}"
limit="${LIMIT:-100}"
widths="${WIDTHS:-512,1024}"
min_global_usage="${MIN_GLOBAL_USAGE:-0}"
min_local_usage="${MIN_LOCAL_USAGE:-0}"
thumb_width="${THUMB_WIDTH:-1024}"
download_delay_ms="${DOWNLOAD_DELAY_MS:-5000}"
wikimedia_maxlag="${WIKIMEDIA_MAXLAG:-5}"
offset_file="${OFFSET_FILE:-.wikimedia-search-offset}"
refresh_existing="${REFRESH_EXISTING:-0}"
restart_delay="${RESTART_DELAY:-10}"
success_delay="${SUCCESS_DELAY:-60}"
max_failures="${MAX_FAILURES:-0}"
failure_count=0
run_count=0

current_offset="${SEARCH_OFFSET:-}"
if [ "$current_offset" = "" ] && [ -f "$offset_file" ]; then
  current_offset="$(cat "$offset_file")"
fi
if ! [[ "$current_offset" =~ ^[0-9]+$ ]]; then
  current_offset=0
fi

echo "scrape-wikimedia: continuous mode started; press Ctrl-C to stop" >&2
echo "scrape-wikimedia: query='${query}', limit=${limit}, widths=${widths}, min_global_usage=${min_global_usage}, min_local_usage=${min_local_usage}, thumb_width=${thumb_width}, download_delay_ms=${download_delay_ms}, wikimedia_maxlag=${wikimedia_maxlag}, refresh_existing=${refresh_existing}, offset_file=${offset_file}" >&2
if [ "${WIKIMEDIA_USER_AGENT:-}" = "" ]; then
  echo "scrape-wikimedia: WIKIMEDIA_USER_AGENT is not set; set it to include contact info for long runs" >&2
fi

while true; do
  run_count="$((run_count + 1))"
  echo "scrape-wikimedia: run ${run_count} starting at search offset ${current_offset}" >&2

  args=(
    dist/index.js
    wikimedia
    --query "$query"
    --limit "$limit"
    --widths "$widths"
    --min-global-usage "$min_global_usage"
    --min-local-usage "$min_local_usage"
    --thumb-width "$thumb_width"
    --download-delay-ms "$download_delay_ms"
    --search-offset "$current_offset"
  )

  if [ "$refresh_existing" != "0" ]; then
    args+=(--refresh-existing)
  fi

  if [ "${WEB_ROOT:-}" != "" ]; then
    args+=(--web-root "$WEB_ROOT")
  fi

  "$node_bin" "${args[@]}"
  status="$?"

  if [ "$status" -eq 0 ]; then
    failure_count=0
    current_offset="$((current_offset + limit))"
    printf "%s\n" "$current_offset" > "$offset_file"
    echo "scrape-wikimedia: run ${run_count} finished; restarting in ${success_delay}s" >&2
    sleep "$success_delay"
    continue
  fi

  failure_count="$((failure_count + 1))"
  if [ "$max_failures" -gt 0 ] && [ "$failure_count" -gt "$max_failures" ]; then
    echo "scrape-wikimedia: failed ${failure_count} times; stopping" >&2
    exit "$status"
  fi

  echo "scrape-wikimedia: run ${run_count} exited with ${status}; restarting after failure ${failure_count} in ${restart_delay}s" >&2
  sleep "$restart_delay"
done
