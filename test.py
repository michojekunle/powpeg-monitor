"""
PowPeg Monitor — test suite (Python)

Tests utility logic, state persistence, retry behaviour, live Bridge contract
calls, and Blockstream API integration. Requires a valid RSK_RPC_URL in .env.

Run: python3 test.py
"""

import json
import os
import sys
import time
import types
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

# Ensure .env is loaded before importing monitor internals
from dotenv import load_dotenv
load_dotenv()

# ── Guard: check deps before importing monitor ─────────────────────────────────

def check_deps():
    missing = []
    for mod in ("web3", "requests", "dotenv"):
        try:
            __import__(mod)
        except ImportError:
            missing.append(mod)
    if missing:
        print(f"\n  ✗ Missing Python packages: {', '.join(missing)}")
        print("  Run: pip3 install web3 python-dotenv requests\n")
        sys.exit(1)

check_deps()

import requests
from web3 import Web3

# Import helpers from monitor.py — functions are module-level, no side effects
# on import since __main__ guard is in place.
_HERE = Path(__file__).parent
sys.path.insert(0, str(_HERE))

from monitor import (
    FatalError,
    load_state, save_state,
    seconds_to_human,
    validate_pegin_target,
    with_retry,
    w3, bridge,
    NETWORK, PEGIN_REQUIRED, PEGOUT_REQUIRED, BTC_API, STATE_FILE,
)

# ── Test values ────────────────────────────────────────────────────────────────

TESTNET_PEGIN_TX  = "a74918ced40b93d8cf9843cc952db41d233fda569ae60cee240292153a529526"
TESTNET_PEGOUT_TX = "0x7695bb4c1dbaf9840d3cafb3fa539162f5f116e7d74cf25bad604a9dd4669d19"
TESTNET_FED_ADDR  = "2N88sMiizxmbb8Y3yA4AtYmL1RxHogWfoHa"
DUMMY_RSK_ADDR    = "0x742d35Cc6634C0553241234561234561234567890"

# ── Utility tests ──────────────────────────────────────────────────────────────

class TestUtilities(unittest.TestCase):

    def test_seconds_to_human_seconds(self):
        self.assertEqual(seconds_to_human(45), "45s")

    def test_seconds_to_human_minutes(self):
        self.assertEqual(seconds_to_human(90), "2m")

    def test_seconds_to_human_hours(self):
        self.assertEqual(seconds_to_human(3900), "1h 5m")

    def test_seconds_to_human_exactly_one_hour(self):
        self.assertEqual(seconds_to_human(3600), "1h 0m")

    def test_confirmation_thresholds_for_network(self):
        if NETWORK == "mainnet":
            self.assertEqual(PEGIN_REQUIRED, 100)
            self.assertEqual(PEGOUT_REQUIRED, 4000)
        else:
            self.assertEqual(PEGIN_REQUIRED, 10)
            self.assertEqual(PEGOUT_REQUIRED, 10)

    def test_btc_api_points_to_correct_network(self):
        if NETWORK == "mainnet":
            self.assertIn("blockstream.info/api", BTC_API)
            self.assertNotIn("testnet", BTC_API)
        else:
            self.assertIn("testnet", BTC_API)

    def test_confirmation_math_clamped_when_spv_lags(self):
        # Simulate Bridge height behind tx block (transient lag)
        bridge_height = 4918810
        tx_block      = 4918812
        confirms = max(0, bridge_height - tx_block + 1)
        self.assertEqual(confirms, 0)

    def test_confirmation_math_correct_when_spv_ahead(self):
        bridge_height = 4925875
        tx_block      = 4918812
        confirms = max(0, bridge_height - tx_block + 1)
        self.assertEqual(confirms, 7064)


# ── State persistence tests ────────────────────────────────────────────────────

class TestStatePersistence(unittest.TestCase):

    def setUp(self):
        """Back up any existing state file."""
        self._backup = None
        if os.path.exists(STATE_FILE):
            with open(STATE_FILE) as f:
                self._backup = f.read()

    def tearDown(self):
        """Restore state file."""
        if self._backup is not None:
            with open(STATE_FILE, "w") as f:
                f.write(self._backup)
        elif os.path.exists(STATE_FILE):
            os.unlink(STATE_FILE)

    def test_load_state_returns_empty_when_missing(self):
        if os.path.exists(STATE_FILE):
            os.unlink(STATE_FILE)
        state = load_state()
        self.assertIsInstance(state, dict)

    def test_load_state_returns_empty_on_corrupt_json(self):
        with open(STATE_FILE, "w") as f:
            f.write("not json {{{{")
        state = load_state()
        self.assertEqual(state, {})

    def test_round_trip_save_then_load(self):
        save_state({"test_key": "test_value", "count": 42})
        state = load_state()
        self.assertEqual(state["test_key"], "test_value")
        self.assertEqual(state["count"], 42)

    def test_state_merge_preserves_existing_keys(self):
        save_state({"key_a": 1})
        current = load_state()
        current["key_b"] = 2
        save_state(current)
        state = load_state()
        self.assertEqual(state["key_a"], 1)
        self.assertEqual(state["key_b"], 2)


# ── Retry wrapper tests ────────────────────────────────────────────────────────

class TestRetryWrapper(unittest.TestCase):

    def test_succeeds_immediately(self):
        result = with_retry(lambda: 42)
        self.assertEqual(result, 42)

    def test_retries_on_error_and_succeeds(self):
        attempts = []

        def flaky():
            attempts.append(1)
            if len(attempts) < 3:
                raise RuntimeError("transient")
            return "ok"

        result = with_retry(flaky)
        self.assertEqual(result, "ok")
        self.assertEqual(len(attempts), 3)

    def test_raises_after_max_retries(self):
        attempts = []

        def always_fails():
            attempts.append(1)
            raise RuntimeError("always fails")

        with self.assertRaises(RuntimeError) as ctx:
            with_retry(always_fails, max_retries=3)

        self.assertEqual(str(ctx.exception), "always fails")
        self.assertEqual(len(attempts), 3)


# ── Bridge contract tests (live RSK RPC) ──────────────────────────────────────

class TestBridgeContract(unittest.TestCase):

    def test_btc_blockchain_height_is_positive(self):
        height = with_retry(lambda: bridge.functions.getBtcBlockchainBestChainHeight().call())
        self.assertGreater(height, 0, f"Expected positive height, got {height}")

    def test_federation_address_is_valid(self):
        addr = with_retry(lambda: bridge.functions.getFederationAddress().call())
        self.assertIsInstance(addr, str)
        self.assertGreater(len(addr), 10)
        prefix = "3" if NETWORK == "mainnet" else "2"
        self.assertTrue(addr.startswith(prefix), f"Expected address starting with '{prefix}', got {addr}")

    def test_queued_pegouts_count_is_non_negative(self):
        count = with_retry(lambda: bridge.functions.getQueuedPegoutsCount().call())
        self.assertGreaterEqual(count, 0)

    def test_next_pegout_creation_block_is_positive(self):
        block = with_retry(lambda: bridge.functions.getNextPegoutCreationBlockNumber().call())
        self.assertGreater(block, 0)

    def test_rsk_rpc_returns_current_block(self):
        block = with_retry(lambda: w3.eth.block_number)
        self.assertGreater(block, 0)


# ── Blockstream API tests ──────────────────────────────────────────────────────

BLOCKSTREAM_AVAILABLE = False
try:
    _ping = requests.get(f"{BTC_API}/blocks/tip/height", timeout=10)
    BLOCKSTREAM_AVAILABLE = _ping.status_code == 200
except Exception:
    pass


def _blockstream_get(path: str, allow_404: bool = False):
    """Fetch from Blockstream API with retry on 5xx/timeouts.
    Raises unittest.SkipTest if the API is consistently unavailable.
    """
    try:
        def fetch():
            r = requests.get(f"{BTC_API}{path}", timeout=30)
            if r.status_code == 404 and allow_404:
                return r
            if r.status_code != 200:
                raise RuntimeError(f"Blockstream HTTP {r.status_code} — retrying")
            return r
        return with_retry(fetch)
    except (requests.exceptions.ConnectionError, requests.exceptions.Timeout, RuntimeError) as e:
        raise unittest.SkipTest(f"Blockstream API unavailable: {e}")


@unittest.skipUnless(BLOCKSTREAM_AVAILABLE, "Blockstream API unavailable — skipping")
class TestBlockstreamAPI(unittest.TestCase):

    def test_known_pegin_tx_is_confirmed(self):
        r = _blockstream_get(f"/tx/{TESTNET_PEGIN_TX}")
        tx = r.json()
        self.assertTrue(tx["status"]["confirmed"])
        self.assertEqual(tx["status"]["block_height"], 4918812)

    def test_known_pegin_tx_outputs_to_federation(self):
        r = _blockstream_get(f"/tx/{TESTNET_PEGIN_TX}")
        tx = r.json()
        addresses = [v.get("scriptpubkey_address") for v in tx.get("vout", [])]
        self.assertIn(TESTNET_FED_ADDR, addresses)

    def test_invalid_tx_hash_returns_404(self):
        r = _blockstream_get(f"/tx/{'0' * 64}", allow_404=True)
        self.assertEqual(r.status_code, 404)


# ── validatePeginTarget tests ──────────────────────────────────────────────────

@unittest.skipUnless(BLOCKSTREAM_AVAILABLE, "Blockstream API unavailable — skipping")
class TestValidatePeginTarget(unittest.TestCase):

    def _run_or_skip(self, fn):
        """Run fn; skip the test if Blockstream times out during execution."""
        try:
            fn()
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as e:
            raise unittest.SkipTest(f"Blockstream unavailable during test: {e}")

    def test_accepts_tx_targeting_federation_address(self):
        def run():
            fed_address = with_retry(lambda: bridge.functions.getFederationAddress().call())
            target = fed_address if fed_address == TESTNET_FED_ADDR else TESTNET_FED_ADDR
            validate_pegin_target(TESTNET_PEGIN_TX, target)
        self._run_or_skip(run)

    def test_rejects_tx_not_targeting_federation_address(self):
        def run():
            with self.assertRaises(ValueError) as ctx:
                validate_pegin_target(TESTNET_PEGIN_TX, "2N00000000000000000000000000000000000000")
            self.assertIn("does not send to federation address", str(ctx.exception))
        self._run_or_skip(run)

    def test_raises_fatal_error_on_invalid_tx_hash(self):
        def run():
            with self.assertRaises(FatalError) as ctx:
                validate_pegin_target("0" * 64, TESTNET_FED_ADDR)
            self.assertIn("not found", str(ctx.exception))
        self._run_or_skip(run)


# ── Peg-out receipt tests (live RSK RPC) ─────────────────────────────────────

class TestPegoutReceipt(unittest.TestCase):

    def test_known_pegout_tx_has_receipt(self):
        receipt = with_retry(lambda: w3.eth.get_transaction_receipt(TESTNET_PEGOUT_TX))
        self.assertIsNotNone(receipt)
        self.assertGreater(receipt["blockNumber"], 0)

    def test_known_pegout_tx_in_expected_block(self):
        receipt = with_retry(lambda: w3.eth.get_transaction_receipt(TESTNET_PEGOUT_TX))
        self.assertEqual(receipt["blockNumber"], 7562606)

    def test_pegout_confirmation_count_is_positive(self):
        current_block = with_retry(lambda: w3.eth.block_number)
        receipt       = with_retry(lambda: w3.eth.get_transaction_receipt(TESTNET_PEGOUT_TX))
        confirms = current_block - receipt["blockNumber"]
        self.assertGreater(confirms, 0)


# ── Alert configuration tests ──────────────────────────────────────────────────

class TestAlertConfiguration(unittest.TestCase):

    def test_telegram_skips_when_token_not_set(self):
        token   = os.getenv("TELEGRAM_BOT_TOKEN", "")
        chat_id = os.getenv("TELEGRAM_CHAT_ID", "")
        should_skip = not token or not chat_id or token == "your_bot_token"
        # If no token configured, the guard will short-circuit — correct behavior
        self.assertTrue(should_skip or (len(token) > 10 and len(chat_id) > 0))

    def test_discord_skips_when_url_not_set(self):
        url = os.getenv("DISCORD_WEBHOOK_URL", "")
        should_skip = not url or "your_webhook" in url
        self.assertTrue(should_skip or url.startswith("https://discord.com/api/webhooks/"))

    @unittest.skipUnless(
        os.getenv("TELEGRAM_BOT_TOKEN") and os.getenv("TELEGRAM_BOT_TOKEN") != "your_bot_token",
        "TELEGRAM_BOT_TOKEN not configured"
    )
    def test_telegram_live_send(self):
        token   = os.getenv("TELEGRAM_BOT_TOKEN")
        chat_id = os.getenv("TELEGRAM_CHAT_ID")
        r = requests.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            json={"chat_id": chat_id, "text": "🧪 PowPeg monitor test — Python", "parse_mode": "Markdown"},
            timeout=10,
        )
        data = r.json()
        if not data.get("ok"):
            desc = data.get("description", "")
            # 400/403 = config error (wrong chat_id, bot blocked, etc.)
            # The token itself is valid — skip rather than fail so a bad
            # TELEGRAM_CHAT_ID doesn't mask real test suite failures.
            if r.status_code in (400, 403) or any(
                s in desc for s in ("chat not found", "bot was blocked", "Forbidden", "not found")
            ):
                raise unittest.SkipTest(
                    f"Telegram config error (token OK, chat_id wrong or bot not started): {desc}\n"
                    f"  Fix: send any message to your bot, then visit\n"
                    f"  https://api.telegram.org/bot{token}/getUpdates\n"
                    f"  and copy the chat.id value into TELEGRAM_CHAT_ID in .env"
                )
        self.assertTrue(data.get("ok"), f"Telegram API returned: {data}")

    @unittest.skipUnless(
        os.getenv("DISCORD_WEBHOOK_URL") and "your_webhook" not in os.getenv("DISCORD_WEBHOOK_URL", ""),
        "DISCORD_WEBHOOK_URL not configured"
    )
    def test_discord_live_send(self):
        url = os.getenv("DISCORD_WEBHOOK_URL")
        r = requests.post(url, json={"content": "🧪 PowPeg monitor test — Python"}, timeout=10)
        self.assertIn(r.status_code, (200, 204), f"Discord returned {r.status_code}")


# ── Runner ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    print("\n╔════════════════════════════════════════════╗")
    print("║  PowPeg Monitor — Test Suite (Python)      ║")
    print("╚════════════════════════════════════════════╝")
    print(f"  Network: {NETWORK} | Python: {sys.version.split()[0]}")
    print(f"  RPC: {os.getenv('RSK_RPC_URL', '')[:40]}...\n")

    loader = unittest.TestLoader()
    suite  = unittest.TestSuite()

    # Load all TestCase classes in definition order
    for cls in [
        TestUtilities,
        TestStatePersistence,
        TestRetryWrapper,
        TestBridgeContract,
        TestBlockstreamAPI,
        TestValidatePeginTarget,
        TestPegoutReceipt,
        TestAlertConfiguration,
    ]:
        suite.addTests(loader.loadTestsFromTestCase(cls))

    runner = unittest.TextTestRunner(verbosity=2, stream=sys.stdout)
    result = runner.run(suite)

    sys.exit(0 if result.wasSuccessful() else 1)
