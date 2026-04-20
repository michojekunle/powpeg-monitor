#!/usr/bin/env bash
# PowPeg Monitor — end-to-end test runner
#
# Checks dependencies, installs packages, runs the JS and Python test suites,
# smoke-tests the live monitor output, and verifies alert endpoints.
#
# Usage:
#   ./test.sh              # full suite
#   ./test.sh --js-only    # JavaScript tests only
#   ./test.sh --py-only    # Python tests only
#   ./test.sh --smoke      # smoke tests only (live monitor output)
#   ./test.sh --alerts     # alert endpoint tests only

set -euo pipefail

# ── Colours ────────────────────────────────────────────────────────────────────
RED="\033[0;31m"; GREEN="\033[0;32m"; YELLOW="\033[1;33m"
CYAN="\033[0;36m"; BOLD="\033[1m"; RESET="\033[0m"

pass()  { echo -e "  ${GREEN}✓${RESET}  $*"; }
fail()  { echo -e "  ${RED}✗${RESET}  $*"; FAILURES=$((FAILURES + 1)); }
warn()  { echo -e "  ${YELLOW}⚠${RESET}  $*"; }
info()  { echo -e "  ${CYAN}→${RESET}  $*"; }
section() { local label="$*"; echo -e "\n${BOLD}── ${label} $(printf '%.0s─' $(seq 1 $((48 - ${#label}))))${RESET}"; }

FAILURES=0
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# ── Portable timeout ──────────────────────────────────────────────────────────
# macOS does not ship GNU timeout. Prefer gtimeout (brew install coreutils),
# then GNU timeout, then a pure-bash fallback using background process + kill.
if command -v gtimeout &>/dev/null; then
  run_timed() { local s=$1; shift; gtimeout "$s" "$@"; }
elif command -v timeout &>/dev/null; then
  run_timed() { local s=$1; shift; timeout "$s" "$@"; }
else
  run_timed() {
    local seconds=$1; shift
    "$@" &
    local pid=$!
    ( sleep "$seconds"; kill "$pid" 2>/dev/null ) &
    local killer=$!
    wait "$pid" 2>/dev/null; local status=$?
    kill "$killer" 2>/dev/null; wait "$killer" 2>/dev/null
    return $status
  }
fi

# ── Real testnet values ────────────────────────────────────────────────────────
PEGIN_TX="a74918ced40b93d8cf9843cc952db41d233fda569ae60cee240292153a529526"
PEGOUT_TX="0x7695bb4c1dbaf9840d3cafb3fa539162f5f116e7d74cf25bad604a9dd4669d19"
DUMMY_RSK_ADDR="0x742d35Cc6634C0553241234561234561234567890"

# ── Args ───────────────────────────────────────────────────────────────────────
RUN_JS=true; RUN_PY=true; RUN_SMOKE=true; RUN_ALERTS=true

for arg in "$@"; do
  case "$arg" in
    # --js-only: unit tests + smoke for JS only (Python smoke skipped via RUN_PY=false)
    --js-only)   RUN_PY=false;                     RUN_ALERTS=false ;;
    # --py-only: unit tests + smoke for Python only (JS smoke skipped explicitly)
    --py-only)   RUN_JS=false;                     RUN_ALERTS=false ;;
    --smoke)     RUN_JS=false;    RUN_PY=false;    RUN_ALERTS=false ;;
    --alerts)    RUN_JS=false;    RUN_PY=false;    RUN_SMOKE=false  ;;
    --no-smoke)  RUN_SMOKE=false ;;
    --no-alerts) RUN_ALERTS=false ;;
  esac
done

echo ""
echo -e "${BOLD}╔════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║     PowPeg Monitor — End-to-End Tests      ║${RESET}"
echo -e "${BOLD}╚════════════════════════════════════════════╝${RESET}"

# ── .env check ─────────────────────────────────────────────────────────────────
section "Environment"

if [ ! -f ".env" ]; then
  warn ".env not found — copying from .env.example"
  cp .env.example .env
  fail "Edit .env with your RSK_RPC_URL before running tests"
  exit 1
fi

RSK_RPC_URL=$(grep -E '^RSK_RPC_URL=' .env | cut -d= -f2- | tr -d '"' | tr -d "'")
NETWORK=$(grep -E '^NETWORK=' .env | cut -d= -f2- | tr -d '"' | tr -d "'" || echo "testnet")

if [ -z "$RSK_RPC_URL" ] || [[ "$RSK_RPC_URL" == *"YOUR_API_KEY"* ]]; then
  fail "RSK_RPC_URL is not set in .env — get a free key at dashboard.rpc.rootstock.io or alchemy.com"
  exit 1
fi

pass ".env loaded (NETWORK=$NETWORK)"
info "RPC: ${RSK_RPC_URL:0:45}..."

# ── Node.js check ──────────────────────────────────────────────────────────────
section "Node.js"

if ! command -v node &>/dev/null; then
  fail "node not found — install Node.js v18+ from nodejs.org"
  exit 1
fi

NODE_VER=$(node --version | tr -d 'v')
NODE_MAJOR=$(echo "$NODE_VER" | cut -d. -f1)
if [ "$NODE_MAJOR" -lt 18 ]; then
  fail "Node.js v$NODE_VER is too old — v18+ required"
  exit 1
fi
pass "Node.js v$NODE_VER"

# ── npm install ────────────────────────────────────────────────────────────────
if [ ! -d "node_modules" ]; then
  info "node_modules not found — running npm install..."
  npm install --silent
fi
pass "npm packages installed"

# ── Python check ───────────────────────────────────────────────────────────────
section "Python"

# Find a working Python 3.10+ with a functional pyexpat (3.14 is broken on macOS)
PYTHON=""

find_python() {
  local candidates=("python3.13" "python3.12" "python3.11" "python3.10" "python3" "python")
  for cmd in "${candidates[@]}"; do
    if command -v "$cmd" &>/dev/null; then
      local ver
      ver=$("$cmd" --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+' | head -1)
      local major minor
      major=$(echo "$ver" | cut -d. -f1)
      minor=$(echo "$ver" | cut -d. -f2)

      # Require 3.10+
      if [ "$major" -lt 3 ] || { [ "$major" -eq 3 ] && [ "$minor" -lt 10 ]; }; then
        continue
      fi

      # Test pyexpat — broken in Homebrew Python 3.14 on macOS
      if "$cmd" -c "import xml.parsers.expat" 2>/dev/null; then
        PYTHON="$cmd"
        return 0
      else
        warn "$cmd $ver has a broken pyexpat (likely Homebrew Python 3.14 + macOS libexpat mismatch)"
      fi
    fi
  done
  return 1
}

if ! find_python; then
  fail "No working Python 3.10+ found"
  echo ""
  echo -e "  ${YELLOW}Fix options:${RESET}"
  echo "    brew install python@3.12   # recommended"
  echo "    brew install python@3.13"
  echo ""
  echo "  Then re-run this script — it will pick up the new version automatically."
  RUN_PY=false
else
  PY_VER=$("$PYTHON" --version 2>&1 | grep -oE '[0-9]+\.[0-9]+\.[0-9]+')
  pass "Python $PY_VER ($PYTHON)"
fi

# ── pip install ────────────────────────────────────────────────────────────────
if [ "$RUN_PY" = true ]; then
  # Always use '$PYTHON -m pip' so packages install into exactly the Python
  # interpreter that was selected above — never an independently-found pip3
  # which may target a different (possibly broken) Python version.
  PIP="$PYTHON -m pip"

  # Verify pip is available for this Python
  if ! $PIP --version &>/dev/null; then
    warn "pip not available for $PYTHON — trying to bootstrap with ensurepip"
    if ! "$PYTHON" -m ensurepip --upgrade --quiet 2>&1; then
      fail "Could not bootstrap pip for $PYTHON. Try: $PYTHON -m ensurepip or brew reinstall python@3.12"
      RUN_PY=false
    fi
  fi

  if [ "$RUN_PY" = true ]; then
    MISSING_DEPS=false
    for pkg in web3 dotenv requests; do
      if ! "$PYTHON" -c "import $pkg" 2>/dev/null; then
        MISSING_DEPS=true
        break
      fi
    done

    if [ "$MISSING_DEPS" = true ]; then
      info "Installing Python dependencies into $PYTHON..."
      if ! $PIP install web3 python-dotenv requests --quiet 2>&1; then
        fail "pip install failed."
        warn "Try manually:  $PYTHON -m pip install web3 python-dotenv requests"
        warn "If you see an expat/dylib error, your Python build is broken:"
        warn "  brew install python@3.12  then re-run this script"
        RUN_PY=false
      else
        pass "Python dependencies installed (into $PYTHON)"
      fi
    else
      pass "Python dependencies already installed"
    fi
  fi
fi

# ── JavaScript tests ───────────────────────────────────────────────────────────
if [ "$RUN_JS" = true ]; then
  section "JavaScript test suite"
  if node test.js; then
    pass "JavaScript test suite passed"
  else
    fail "JavaScript test suite failed"
  fi
fi

# ── Python tests ───────────────────────────────────────────────────────────────
if [ "$RUN_PY" = true ]; then
  section "Python test suite"
  if "$PYTHON" test.py; then
    pass "Python test suite passed"
  else
    fail "Python test suite failed"
  fi
fi

# ── Smoke tests: live monitor output ──────────────────────────────────────────
if [ "$RUN_SMOKE" = true ]; then
  section "Smoke tests (live monitor output)"

  if [ "$RUN_JS" = true ]; then
    info "Testing JS peg-out monitor (30s timeout)..."
    PEGOUT_OUT=$(run_timed 30 node monitor.js pegout "$PEGOUT_TX" 2>&1 || true)
    if echo "$PEGOUT_OUT" | grep -q "PEG-OUT"; then
      pass "JS peg-out monitor renders dashboard"
      if echo "$PEGOUT_OUT" | grep -q "Confirmations"; then
        pass "JS peg-out monitor shows confirmation count"
      else
        fail "JS peg-out monitor missing confirmation count"
      fi
    else
      fail "JS peg-out monitor did not render dashboard"
      echo "$PEGOUT_OUT" | tail -10
    fi

    info "Testing JS peg-in monitor (30s timeout)..."
    PEGIN_OUT=$(run_timed 30 node monitor.js pegin "$PEGIN_TX" "$DUMMY_RSK_ADDR" 2>&1 || true)
    if echo "$PEGIN_OUT" | grep -q "PEG-IN"; then
      pass "JS peg-in monitor renders dashboard"
      if echo "$PEGIN_OUT" | grep -q "Federation address:"; then
        pass "JS peg-in monitor validates federation address"
      else
        fail "JS peg-in monitor missing federation address validation"
      fi
    else
      fail "JS peg-in monitor did not render dashboard"
      echo "$PEGIN_OUT" | tail -10
    fi
  fi

  if [ "$RUN_PY" = true ] && [ -n "$PYTHON" ]; then
    info "Testing Python peg-out monitor (30s timeout)..."
    PY_PEGOUT_OUT=$(run_timed 30 "$PYTHON" monitor.py pegout "$PEGOUT_TX" 2>&1 || true)
    if echo "$PY_PEGOUT_OUT" | grep -q "PEG-OUT"; then
      pass "Python peg-out monitor renders dashboard"
    else
      fail "Python peg-out monitor did not render dashboard"
      echo "$PY_PEGOUT_OUT" | tail -10
    fi

    info "Testing Python peg-in monitor (30s timeout)..."
    PY_PEGIN_OUT=$(run_timed 30 "$PYTHON" monitor.py pegin "$PEGIN_TX" "$DUMMY_RSK_ADDR" 2>&1 || true)
    if echo "$PY_PEGIN_OUT" | grep -q "PEG-IN"; then
      pass "Python peg-in monitor renders dashboard"
    else
      fail "Python peg-in monitor did not render dashboard"
      echo "$PY_PEGIN_OUT" | tail -10
    fi
  fi

  # State file should now exist
  if [ -f "monitor-state.json" ]; then
    pass "State file (monitor-state.json) created"
    info "State: $(cat monitor-state.json | tr -d '\n')"
  else
    warn "State file not created (may be normal on first run error)"
  fi
fi

# ── Alert endpoint tests ───────────────────────────────────────────────────────
if [ "$RUN_ALERTS" = true ]; then
  section "Alert endpoints"

  TELEGRAM_TOKEN=$(grep -E '^TELEGRAM_BOT_TOKEN=' .env | cut -d= -f2- | tr -d '"' | tr -d "'" || echo "")
  TELEGRAM_CHAT=$(grep -E '^TELEGRAM_CHAT_ID=' .env | cut -d= -f2- | tr -d '"' | tr -d "'" || echo "")
  DISCORD_URL=$(grep -E '^DISCORD_WEBHOOK_URL=' .env | cut -d= -f2- | tr -d '"' | tr -d "'" || echo "")

  if [ -z "$TELEGRAM_TOKEN" ] || [ "$TELEGRAM_TOKEN" = "your_bot_token" ]; then
    warn "Telegram not configured — skipping (set TELEGRAM_BOT_TOKEN + TELEGRAM_CHAT_ID in .env)"
  else
    info "Sending Telegram test message..."
    TG_RESP=$(curl -s -X POST \
      "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
      -H "Content-Type: application/json" \
      -d "{\"chat_id\":\"${TELEGRAM_CHAT}\",\"text\":\"🧪 PowPeg monitor test — bash\"}")
    if echo "$TG_RESP" | grep -q '"ok":true'; then
      pass "Telegram alert delivered"
    elif echo "$TG_RESP" | grep -qE '"error_code":(400|403)|chat not found|bot was blocked|Forbidden'; then
      # Config error (wrong chat_id, bot blocked, etc.) — warn, don't fail
      warn "Telegram config error (token works, but chat_id is wrong or bot not started)"
      warn "Fix: open Telegram → send any message to your bot → visit:"
      warn "  https://api.telegram.org/bot${TELEGRAM_TOKEN}/getUpdates"
      warn "  and copy the \"id\" from the \"chat\" object into TELEGRAM_CHAT_ID in .env"
    else
      fail "Telegram alert failed: $TG_RESP"
    fi
  fi

  if [ -z "$DISCORD_URL" ] || echo "$DISCORD_URL" | grep -q "your_webhook"; then
    warn "Discord not configured — skipping (set DISCORD_WEBHOOK_URL in .env)"
  else
    info "Sending Discord test message..."
    DISCORD_STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
      -H "Content-Type: application/json" \
      -d '{"content":"🧪 PowPeg monitor test — bash"}' \
      "$DISCORD_URL")
    if [ "$DISCORD_STATUS" = "204" ] || [ "$DISCORD_STATUS" = "200" ]; then
      pass "Discord alert delivered (HTTP $DISCORD_STATUS)"
    else
      fail "Discord alert failed (HTTP $DISCORD_STATUS)"
    fi
  fi
fi

# ── Summary ────────────────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}$(printf '%.0s─' $(seq 1 52))${RESET}"

if [ "$FAILURES" -eq 0 ]; then
  echo -e "  ${GREEN}${BOLD}All checks passed.${RESET}"
else
  echo -e "  ${RED}${BOLD}$FAILURES check(s) failed.${RESET}"
  echo ""
  echo "  Common fixes:"
  echo "    • RSK_RPC_URL not set       → get a free key at dashboard.rpc.rootstock.io"
  echo "    • Python pyexpat error      → brew install python@3.12"
  echo "    • web3 not installed        → python3 -m pip install web3 python-dotenv requests"
  echo "    • Blockstream unavailable   → transient DNS issue; re-run in a few seconds"
  echo "    • Telegram chat not found   → send a message to your bot first, then check"
  echo "                                  https://api.telegram.org/bot<TOKEN>/getUpdates"
  echo "                                  and copy the chat.id into TELEGRAM_CHAT_ID"
fi

echo ""
exit "$FAILURES"
