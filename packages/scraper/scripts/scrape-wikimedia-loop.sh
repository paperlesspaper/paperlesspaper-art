#!/usr/bin/env bash
set -u

node_bin="${NODE_BIN:-node}"
limit="${LIMIT:-100}"
widths="${WIDTHS:-512,1024}"
min_global_usage="${MIN_GLOBAL_USAGE:-0}"
min_local_usage="${MIN_LOCAL_USAGE:-0}"
thumb_width="${THUMB_WIDTH:-1024}"
allow_duplicate_titles="${ALLOW_DUPLICATE_TITLES:-0}"
revisit_rejected_previews="${REVISIT_REJECTED_PREVIEWS:-0}"
disable_candidate_filters="${DISABLE_CANDIDATE_FILTERS:-0}"
ignore_usage_filter="${IGNORE_USAGE_FILTER:-0}"
art_filter_mode="${ART_FILTER_MODE:-broad}"
review_mode="${REVIEW_MODE:-both}"
full_download_concurrency="${FULL_DOWNLOAD_CONCURRENCY:-3}"
preview_review="${PREVIEW_REVIEW:-0}"
preview_width="${PREVIEW_WIDTH:-160}"
preview_review_dir="${PREVIEW_REVIEW_DIR:-.wikimedia-preview-review}"
download_delay_ms="${DOWNLOAD_DELAY_MS:-5000}"
wikimedia_maxlag="${WIKIMEDIA_MAXLAG:-5}"
offset_file="${OFFSET_FILE:-.wikimedia-search-offset}"
offset_dir="${OFFSET_DIR:-.wikimedia-search-offsets}"
refresh_existing="${REFRESH_EXISTING:-0}"
restart_delay="${RESTART_DELAY:-10}"
success_delay="${SUCCESS_DELAY:-60}"
max_failures="${MAX_FAILURES:-0}"
failure_count=0
run_count=0
query_index=0
queries=()
offset_files=()
offsets=()

trim_keyword() {
  local value="$1"
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  printf "%s" "$value"
}

offset_key_for_query() {
  local query="$1"
  local key
  local checksum

  key="$(printf "%s" "$query" | tr '[:upper:]' '[:lower:]' | tr -cs '[:alnum:]' '-' | sed 's/^-//; s/-$//')"
  checksum="$(printf "%s" "$query" | cksum)"
  checksum="${checksum%% *}"

  if [ "$key" = "" ]; then
    key="query"
  fi

  printf "%s-%s" "$key" "$checksum"
}

offset_file_for_query() {
  local query="$1"

  if [ "$query_count" -eq 1 ]; then
    printf "%s" "$offset_file"
    return
  fi

  printf "%s/%s" "$offset_dir" "$(offset_key_for_query "$query")"
}

initial_offset_for_file() {
  local file="$1"
  local current_offset="${SEARCH_OFFSET:-}"

  if [ "$current_offset" = "" ] && [ -f "$file" ]; then
    current_offset="$(cat "$file")"
  fi

  if ! [[ "$current_offset" =~ ^[0-9]+$ ]]; then
    current_offset=0
  fi

  printf "%s" "$current_offset"
}

if [ "$#" -gt 0 ]; then
  for keyword in "$@"; do
    keyword="$(trim_keyword "$keyword")"
    if [ "$keyword" != "" ]; then
      queries+=("$keyword")
    fi
  done
elif [ "${KEYWORDS:-}" != "" ]; then
  while IFS= read -r keyword || [ -n "$keyword" ]; do
    keyword="$(trim_keyword "$keyword")"
    if [ "$keyword" != "" ]; then
      queries+=("$keyword")
    fi
  done < <(printf "%s" "$KEYWORDS" | tr ',;|' '\n')
else
  queries=("${QUERY:-paintings}")
fi

query_count="${#queries[@]}"
if [ "$query_count" -eq 0 ]; then
  echo "scrape-wikimedia: no keywords provided" >&2
  exit 64
fi

if ! [[ "$limit" =~ ^[1-9][0-9]*$ ]]; then
  echo "scrape-wikimedia: LIMIT must be a positive integer" >&2
  exit 64
fi

if [ "$query_count" -gt 1 ]; then
  mkdir -p "$offset_dir"
fi

for query in "${queries[@]}"; do
  query_offset_file="$(offset_file_for_query "$query")"
  offset_files+=("$query_offset_file")
  offsets+=("$(initial_offset_for_file "$query_offset_file")")
done

echo "scrape-wikimedia: continuous mode started; press Ctrl-C to stop" >&2
if [ "$query_count" -eq 1 ]; then
  echo "scrape-wikimedia: query='${queries[0]}', limit=${limit}, widths=${widths}, min_global_usage=${min_global_usage}, min_local_usage=${min_local_usage}, thumb_width=${thumb_width}, allow_duplicate_titles=${allow_duplicate_titles}, revisit_rejected_previews=${revisit_rejected_previews}, disable_candidate_filters=${disable_candidate_filters}, ignore_usage_filter=${ignore_usage_filter}, art_filter_mode=${art_filter_mode}, review_mode=${review_mode}, full_download_concurrency=${full_download_concurrency}, preview_review=${preview_review}, preview_width=${preview_width}, download_delay_ms=${download_delay_ms}, wikimedia_maxlag=${wikimedia_maxlag}, refresh_existing=${refresh_existing}, offset_file=${offset_files[0]}" >&2
else
  echo "scrape-wikimedia: keywords (${query_count}): $(printf "'%s' " "${queries[@]}")" >&2
  echo "scrape-wikimedia: limit=${limit}, widths=${widths}, min_global_usage=${min_global_usage}, min_local_usage=${min_local_usage}, thumb_width=${thumb_width}, allow_duplicate_titles=${allow_duplicate_titles}, revisit_rejected_previews=${revisit_rejected_previews}, disable_candidate_filters=${disable_candidate_filters}, ignore_usage_filter=${ignore_usage_filter}, art_filter_mode=${art_filter_mode}, review_mode=${review_mode}, full_download_concurrency=${full_download_concurrency}, preview_review=${preview_review}, preview_width=${preview_width}, download_delay_ms=${download_delay_ms}, wikimedia_maxlag=${wikimedia_maxlag}, refresh_existing=${refresh_existing}, offset_dir=${offset_dir}" >&2
fi
if [ "${WIKIMEDIA_USER_AGENT:-}" = "" ]; then
  echo "scrape-wikimedia: WIKIMEDIA_USER_AGENT is not set; set it to include contact info for long runs" >&2
fi

while true; do
  run_count="$((run_count + 1))"
  query="${queries[$query_index]}"
  current_offset="${offsets[$query_index]}"
  current_offset_file="${offset_files[$query_index]}"

  echo "scrape-wikimedia: run ${run_count} starting query '$query' at search offset ${current_offset}" >&2

  args=(
    dist/index.js
    wikimedia
    --query "$query"
    --limit "$limit"
    --widths "$widths"
    --min-global-usage "$min_global_usage"
    --min-local-usage "$min_local_usage"
    --thumb-width "$thumb_width"
    --art-filter "$art_filter_mode"
    --review-mode "$review_mode"
    --full-download-concurrency "$full_download_concurrency"
    --download-delay-ms "$download_delay_ms"
    --search-offset "$current_offset"
  )

  if [ "$allow_duplicate_titles" != "0" ]; then
    args+=(--allow-duplicate-titles)
  fi

  if [ "$revisit_rejected_previews" != "0" ]; then
    args+=(--revisit-rejected-previews)
  fi

  if [ "$ignore_usage_filter" != "0" ]; then
    args+=(--ignore-usage-filter)
  fi

  if [ "$disable_candidate_filters" != "0" ]; then
    args+=(--disable-candidate-filters)
  fi

  if [ "$preview_review" != "0" ]; then
    args+=(
      --preview-review
      --preview-width "$preview_width"
      --preview-review-dir "$preview_review_dir"
    )
  fi

  if [ "$refresh_existing" != "0" ]; then
    args+=(--refresh-existing)
  fi

  if [ "${WEB_ROOT:-}" != "" ]; then
    args+=(--web-root "$WEB_ROOT")
  fi

  "$node_bin" "${args[@]}"
  status="$?"

  if [ "$status" -eq 75 ]; then
    failure_count=0
    echo "scrape-wikimedia: run ${run_count} has pending previews; holding offset ${current_offset}; restarting in ${success_delay}s" >&2
    sleep "$success_delay"
    continue
  fi

  if [ "$status" -eq 0 ]; then
    failure_count=0
    current_offset="$((current_offset + limit))"
    offsets[$query_index]="$current_offset"
    printf "%s\n" "$current_offset" > "$current_offset_file"
    query_index="$(((query_index + 1) % query_count))"
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
