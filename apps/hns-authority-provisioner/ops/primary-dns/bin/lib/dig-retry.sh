#!/usr/bin/env bash
# Sourced by the strict Bash health monitors; preserve the same error policy.
set -euo pipefail

# Bounded retry for a single DNS lookup.
#
# Why: the authoritative health monitors fire ~24 back-to-back queries and treat
# any single non-zero dig exit as a hard failure. Observed 2026-07-21 on the
# secondary (81.15.150.159): isolated names timed out on one run and answered
# immediately on the next, while the zone was demonstrably fine (same SOA serial
# as the primary, 8/8 on retry). That produced false OnFailure alerts, which is
# worse than useless -- it trains operators to ignore the monitor.
#
# Retry the individual lookup, not the whole monitor, so one slow packet cannot
# mask or duplicate unrelated results. A genuine outage still fails: every
# attempt has to fail, and the attempt count is reported so a "passed on retry
# 3" service does not look identical to a healthy one.

# dig_with_retry <output_var> <dig_bin> <args...>
# Returns 0 and assigns the answer on success; returns 1 on exhaustion and
# assigns a diagnostic describing the attempts.
dig_with_retry() {
  local __outvar="$1"; shift
  local dig_bin="$1"; shift

  # These locals are deliberately __-prefixed: a bare name like `answer` would
  # shadow the caller's variable of that name, and `printf -v` would then write
  # to the local instead of the caller's -- leaving the caller with an unset
  # variable under `set -u`.
  local __attempts="${HNS_DIG_RETRY_ATTEMPTS:-3}"
  local __base_delay="${HNS_DIG_RETRY_BASE_DELAY_SECONDS:-1}"
  local __answer="" __attempt=1 __last_error=""

  while (( __attempt <= __attempts )); do
    if __answer="$("$dig_bin" "$@" 2>&1)"; then
      printf -v "$__outvar" '%s' "$__answer"
      if (( __attempt > 1 )); then
        printf 'note: succeeded on attempt %d/%d: %s\n' "$__attempt" "$__attempts" "$*" >&2
      fi
      return 0
    fi
    __last_error="$__answer"
    if (( __attempt < __attempts )); then
      # Small increasing delay: 1s, 2s, 3s... Enough to ride out a dropped
      # packet without stretching the monitor's runtime materially.
      sleep "$(( __base_delay * __attempt ))"
    fi
    (( __attempt++ ))
  done

  printf -v "$__outvar" 'failed after %d attempts; last error: %s' \
    "$__attempts" "${__last_error//$'\n'/ }"
  return 1
}
