#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RPC_URL="${FIVE_RPC_URL:-http://127.0.0.1:8899}"
GUI_URL="${FIVE_GUI_URL:-http://127.0.0.1:4177}"
PROGRAM_KEYPAIR="${ROOT_DIR}/../target/deploy/five-keypair.json"
PROGRAM_SO="${ROOT_DIR}/../target/deploy/five.so"
GUI_LOG="${FIVE_GUI_LOG:-/tmp/5ive-blackjack-gui.log}"
VALIDATOR_LOG="${FIVE_VALIDATOR_LOG:-/tmp/5ive-blackjack-validator.log}"

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

wait_for_rpc() {
  local tries="${1:-30}"
  local i
  for ((i=1; i<=tries; i++)); do
    if solana -u "${RPC_URL}" block-height >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

wait_for_gui() {
  local tries="${1:-30}"
  local i
  for ((i=1; i<=tries; i++)); do
    if curl -fsS "${GUI_URL}/api/state" -X POST -H 'content-type: application/json' -d '{}' >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
  done
  return 1
}

start_validator_if_needed() {
  if solana -u "${RPC_URL}" block-height >/dev/null 2>&1; then
    echo "[dev] local validator already running at ${RPC_URL}"
    return 0
  fi

  echo "[dev] starting local validator..."
  nohup solana-test-validator --reset >"${VALIDATOR_LOG}" 2>&1 &

  if ! wait_for_rpc 45; then
    echo "[dev] validator failed to start. logs: ${VALIDATOR_LOG}" >&2
    exit 1
  fi

  echo "[dev] validator ready at ${RPC_URL}"
}

ensure_five_vm_program() {
  if [[ ! -f "${PROGRAM_KEYPAIR}" || ! -f "${PROGRAM_SO}" ]]; then
    echo "[dev] missing Five VM artifacts:" >&2
    echo "  - ${PROGRAM_KEYPAIR}" >&2
    echo "  - ${PROGRAM_SO}" >&2
    echo "build them first from repo root (e.g. ./scripts/build-five-solana-cluster.sh --cluster localnet)" >&2
    exit 1
  fi

  local program_id
  program_id="$(solana-keygen pubkey "${PROGRAM_KEYPAIR}")"

  if solana -u "${RPC_URL}" program show "${program_id}" >/dev/null 2>&1; then
    echo "[dev] Five VM program already deployed: ${program_id}"
  else
    echo "[dev] deploying Five VM program ${program_id}..."
    solana -u "${RPC_URL}" program deploy "${PROGRAM_SO}" --program-id "${PROGRAM_KEYPAIR}" >/dev/null
    echo "[dev] deploy complete: ${program_id}"
  fi

  echo "[dev] initializing VM state..."
  (cd "${ROOT_DIR}/.." && node scripts/init-localnet-vm-state.mjs --network localnet >/dev/null)
  echo "[dev] VM state ready"

  export FIVE_VM_PROGRAM_ID="${program_id}"
}

start_gui() {
  if curl -fsS "${GUI_URL}/api/state" -X POST -H 'content-type: application/json' -d '{}' >/dev/null 2>&1; then
    echo "[dev] GUI already running: ${GUI_URL}"
    if command -v open >/dev/null 2>&1; then
      open "${GUI_URL}" || true
    fi
    return 0
  fi

  echo "[dev] starting blackjack GUI..."
  : >"${GUI_LOG}"
  (cd "${ROOT_DIR}" && nohup npm run client:gui:localnet >"${GUI_LOG}" 2>&1 & echo $! >"${ROOT_DIR}/.five/blackjack-gui.pid")

  if ! wait_for_gui 45; then
    echo "[dev] GUI failed to start. logs: ${GUI_LOG}" >&2
    tail -n 120 "${GUI_LOG}" >&2 || true
    exit 1
  fi

  echo "[dev] GUI ready: ${GUI_URL}"
  if command -v open >/dev/null 2>&1; then
    open "${GUI_URL}" || true
  fi

  echo "[dev] logs: ${GUI_LOG}"
  echo "[dev] stop GUI: kill \$(cat ${ROOT_DIR}/.five/blackjack-gui.pid)"
}

main() {
  require_cmd solana
  require_cmd solana-keygen
  require_cmd solana-test-validator
  require_cmd curl
  require_cmd npm

  mkdir -p "${ROOT_DIR}/.five"

  start_validator_if_needed
  ensure_five_vm_program
  start_gui
}

main "$@"
