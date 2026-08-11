#!/bin/bash
set -Eeuo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
entrypoint="$repository_root/deploy/docker/postgres-entrypoint.sh"
temporary_parent=/tmp
work_directory="$(mktemp -d "$temporary_parent/moemail-postgres-entrypoint.XXXXXX")"

cleanup() {
  case "$work_directory" in
    "$temporary_parent"/moemail-postgres-entrypoint.*)
      rm -rf -- "$work_directory"
      ;;
    *)
      echo "Refusing to clean unexpected validation path: $work_directory" >&2
      return 1
      ;;
  esac
}
trap cleanup EXIT

render_entrypoint() {
  local cluster_directory="$1"
  local rendered_entrypoint="$2"

  sed "s#^data_directory=/var/lib/postgresql/data\$#data_directory=$cluster_directory#" \
    "$entrypoint" >"$rendered_entrypoint"
  chmod 0700 "$rendered_entrypoint"
}

snapshot_directory() {
  local cluster_directory="$1"

  {
    find "$cluster_directory" -mindepth 1 \
      -printf 'metadata|%P|%y|%m|%U|%G|%s|%T@\n'
    find "$cluster_directory" -type f -exec sha256sum -- {} +
  } | sort
}

expect_rejected_without_mutation() {
  local name="$1"
  local expected_message="$2"
  local cluster_directory="$work_directory/$name"
  local rendered_entrypoint="$work_directory/$name-entrypoint.sh"
  local before after output status

  mkdir -p "$cluster_directory"
  case "$name" in
    old-major)
      printf '17\n' >"$cluster_directory/PG_VERSION"
      printf 'must-remain-byte-identical\n' >"$cluster_directory/sentinel"
      ;;
    incomplete)
      printf 'partial-cluster-must-remain-byte-identical\n' >"$cluster_directory/sentinel"
      ;;
    non-regular-version)
      mkdir "$cluster_directory/PG_VERSION"
      printf 'must-remain-byte-identical\n' >"$cluster_directory/sentinel"
      ;;
    *)
      echo "Unknown validation fixture: $name" >&2
      return 64
      ;;
  esac

  render_entrypoint "$cluster_directory" "$rendered_entrypoint"
  before="$(snapshot_directory "$cluster_directory")"
  set +e
  output="$(bash "$rendered_entrypoint" 2>&1)"
  status=$?
  set -e
  after="$(snapshot_directory "$cluster_directory")"

  if [ "$status" -ne 78 ]; then
    printf 'Expected fixture %s to exit 78, got %s:\n%s\n' "$name" "$status" "$output" >&2
    return 1
  fi
  if ! grep -Fq "$expected_message" <<<"$output"; then
    printf 'Fixture %s did not emit expected error %q:\n%s\n' "$name" "$expected_message" "$output" >&2
    return 1
  fi
  if [ "$before" != "$after" ]; then
    printf 'Fixture %s was mutated despite fail-closed rejection\nBefore:\n%s\nAfter:\n%s\n' \
      "$name" "$before" "$after" >&2
    return 1
  fi
}

expect_rejected_without_mutation old-major \
  'PostgreSQL major versions are not storage-compatible'
expect_rejected_without_mutation incomplete \
  'incomplete PostgreSQL data directory'
expect_rejected_without_mutation non-regular-version \
  'non-regular PostgreSQL version marker'

printf '%s\n' \
  '{"postgres17RejectedWithoutMutation":true,"incompleteClusterRejectedWithoutMutation":true,"nonRegularVersionRejectedWithoutMutation":true}'
