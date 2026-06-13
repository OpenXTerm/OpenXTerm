#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE_NAME="openxterm-ssh-integration:local"
CONTAINER_NAME="openxterm-ssh-integration-$$"
FIXTURE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/openxterm-ssh-integration.XXXXXX")"

cleanup() {
  local exit_code=$?
  if [ "$exit_code" -ne 0 ]; then
    docker logs "$CONTAINER_NAME" 2>/dev/null || true
  fi
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
  rm -rf "$FIXTURE_DIR"
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

if ! docker info >/dev/null 2>&1; then
  echo "Docker is required and its daemon must be running." >&2
  exit 1
fi

docker build \
  --tag "$IMAGE_NAME" \
  --file "$ROOT_DIR/tests/ssh-server/Dockerfile" \
  "$ROOT_DIR/tests/ssh-server"

docker run \
  --detach \
  --rm \
  --name "$CONTAINER_NAME" \
  --publish 127.0.0.1::22 \
  --publish 127.0.0.1::2223 \
  --volume "$FIXTURE_DIR:/fixtures" \
  "$IMAGE_NAME" >/dev/null

for _ in $(seq 1 60); do
  SSH_PORT="$(docker port "$CONTAINER_NAME" 22/tcp 2>/dev/null | awk -F: 'NR == 1 { print $NF }')"
  BLACKHOLE_PORT="$(docker port "$CONTAINER_NAME" 2223/tcp 2>/dev/null | awk -F: 'NR == 1 { print $NF }')"
  if [ -f "$FIXTURE_DIR/ready" ] \
    && [ -n "$SSH_PORT" ] \
    && [ -n "$BLACKHOLE_PORT" ] \
    && docker logs "$CONTAINER_NAME" 2>&1 | grep -q 'Server listening'; then
    break
  fi
  sleep 1
done

if [ ! -f "$FIXTURE_DIR/ready" ] || [ -z "${SSH_PORT:-}" ] || [ -z "${BLACKHOLE_PORT:-}" ]; then
  echo "SSH integration fixture did not become ready." >&2
  exit 1
fi

export OPENXTERM_SSH_TEST_HOST="127.0.0.1"
export OPENXTERM_SSH_TEST_PORT="$SSH_PORT"
export OPENXTERM_SSH_TEST_BLACKHOLE_PORT="$BLACKHOLE_PORT"
export OPENXTERM_SSH_TEST_USERNAME="openxterm"
export OPENXTERM_SSH_TEST_PASSWORD="openxterm-test-password"
export OPENXTERM_SSH_TEST_KEY="$FIXTURE_DIR/id_ed25519"
export OPENXTERM_SSH_TEST_PPK="$FIXTURE_DIR/id_ed25519.ppk"
export OPENXTERM_SSH_TEST_ENCRYPTED_PPK="$FIXTURE_DIR/id_ed25519-encrypted.ppk"
export OPENXTERM_SSH_TEST_KEY_PASSPHRASE="openxterm-test-passphrase"

cargo test \
  --manifest-path "$ROOT_DIR/src-tauri/Cargo.toml" \
  ssh_integration \
  -- \
  --ignored \
  --nocapture \
  --test-threads=1
