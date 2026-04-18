"""
PowPeg bridge monitor — Python version.
Tracks peg-in (BTC → rBTC) and peg-out (rBTC → BTC) confirmation progress.
"""

import json
import os
import sys
import time
from datetime import datetime

import requests
from dotenv import load_dotenv
from web3 import Web3

load_dotenv()

# ── Config ─────────────────────────────────────────────────────────────────────

RSK_RPC_URL    = os.getenv("RSK_RPC_URL")
BRIDGE_ADDRESS = os.getenv("BRIDGE_ADDRESS", "0x0000000000000000000000000000000001000006")
NETWORK        = os.getenv("NETWORK", "testnet")
POLL_INTERVAL  = 60
STATE_FILE     = "monitor-state.json"

PEGIN_REQUIRED  = 100 if NETWORK == "mainnet" else 10
PEGOUT_REQUIRED = 4000 if NETWORK == "mainnet" else 10
BTC_BLOCK_TIME  = 600
RSK_BLOCK_TIME  = 30

BTC_API = (
    "https://blockstream.info/api"
    if NETWORK == "mainnet"
    else "https://blockstream.info/testnet/api"
)

if not RSK_RPC_URL:
    print("RSK_RPC_URL is not set in .env")
    sys.exit(1)

w3 = Web3(Web3.HTTPProvider(RSK_RPC_URL))

with open("bridge-abi.json") as f:
    BRIDGE_ABI = json.load(f)

bridge = w3.eth.contract(
    address=Web3.to_checksum_address(BRIDGE_ADDRESS),
    abi=BRIDGE_ABI,
)

# ── State persistence ──────────────────────────────────────────────────────────

def load_state() -> dict:
    try:
        if os.path.exists(STATE_FILE):
            with open(STATE_FILE) as f:
                return json.load(f)
    except Exception:
        pass
    return {}

def save_state(state: dict) -> None:
    with open(STATE_FILE, "w") as f:
        json.dump(state, f, indent=2)

# ── Utilities ──────────────────────────────────────────────────────────────────

def seconds_to_human(seconds: int) -> str:
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{seconds // 60}m"
    h = seconds // 3600
    m = (seconds % 3600) // 60
    return f"{h}h {m}m"

def print_status(label: str, data: dict) -> None:
    os.system("cls" if os.name == "nt" else "clear")
    print("╔════════════════════════════════════════════╗")
    print(f"║  PowPeg Monitor — {NETWORK.upper():<24}║")
    print("╚════════════════════════════════════════════╝\n")
    print(f"  Type              : {label}")
    for k, v in data.items():
        print(f"  {k:<18}: {v}")
    print(f"\n  Updated           : {datetime.now().strftime('%H:%M:%S')}")
    print("  Press Ctrl+C to stop.\n")

# ── Alerts ─────────────────────────────────────────────────────────────────────

def send_telegram(message: str) -> None:
    token   = os.getenv("TELEGRAM_BOT_TOKEN", "")
    chat_id = os.getenv("TELEGRAM_CHAT_ID", "")
    if not token or not chat_id or token == "your_bot_token":
        return
    try:
        requests.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            json={"chat_id": chat_id, "text": message, "parse_mode": "Markdown"},
            timeout=10,
        )
    except Exception as e:
        print(f"  Telegram alert failed: {e}")

def send_discord(message: str) -> None:
    url = os.getenv("DISCORD_WEBHOOK_URL", "")
    if not url or "your_webhook" in url:
        return
    try:
        requests.post(url, json={"content": message}, timeout=10)
    except Exception as e:
        print(f"  Discord alert failed: {e}")

def send_alert(message: str) -> None:
    print(f"\n  [ALERT] {message}\n")
    send_telegram(message)
    send_discord(message)

# ── Retry wrapper ──────────────────────────────────────────────────────────────

def with_retry(fn, max_retries: int = 3):
    for i in range(max_retries):
        try:
            return fn()
        except Exception as e:
            if i == max_retries - 1:
                raise
            time.sleep(2 ** (i + 1))

# ── Peg-In Monitor ─────────────────────────────────────────────────────────────

def monitor_pegin(btc_tx_hash: str, rsk_address: str) -> None:
    state           = load_state()
    alerted_complete = state.get(f"{btc_tx_hash}_complete", False)

    print(f"\n  Starting peg-in monitor for {btc_tx_hash[:20]}...")
    print(f"  Network: {NETWORK} | Required confirmations: {PEGIN_REQUIRED}\n")

    while True:
        try:
            bridge_btc_height = with_retry(
                lambda: bridge.functions.getBtcBlockchainBestChainHeight().call()
            )
            res  = with_retry(lambda: requests.get(f"{BTC_API}/tx/{btc_tx_hash}", timeout=10))
            tx   = res.json()

            if not tx.get("status", {}).get("confirmed"):
                print_status("PEG-IN (BTC → rBTC)", {
                    "BTC Tx Hash"      : f"{btc_tx_hash[:20]}...",
                    "RSK Address"      : f"{rsk_address[:20]}...",
                    "Bridge BTC Height": str(bridge_btc_height),
                    "BTC Status"       : "Unconfirmed (mempool)",
                    "Confirmations"    : f"0 / {PEGIN_REQUIRED}",
                    "ETA"              : seconds_to_human(PEGIN_REQUIRED * BTC_BLOCK_TIME),
                })
            else:
                tx_block    = tx["status"]["block_height"]
                confirms    = bridge_btc_height - tx_block + 1
                remaining   = max(0, PEGIN_REQUIRED - confirms)
                complete    = confirms >= PEGIN_REQUIRED

                print_status("PEG-IN (BTC → rBTC)", {
                    "BTC Tx Hash"      : f"{btc_tx_hash[:20]}...",
                    "RSK Address"      : f"{rsk_address[:20]}...",
                    "BTC Tx Block"     : str(tx_block),
                    "Bridge BTC Height": str(bridge_btc_height),
                    "Confirmations"    : f"{confirms} / {PEGIN_REQUIRED}",
                    "Status"           : "✓ COMPLETE — rBTC credited" if complete
                                         else f"Waiting ({confirms}/{PEGIN_REQUIRED} BTC blocks)",
                    "ETA"              : seconds_to_human(remaining * BTC_BLOCK_TIME) if remaining > 0 else "Done",
                })

                current = load_state()
                current[f"{btc_tx_hash}_confirms"] = confirms
                save_state(current)

                if complete and not alerted_complete:
                    alerted_complete = True
                    current[f"{btc_tx_hash}_complete"] = True
                    save_state(current)
                    send_alert(
                        f"✅ *PowPeg Peg-In Complete*\n"
                        f"BTC Tx: `{btc_tx_hash}`\n"
                        f"rBTC credited to: `{rsk_address}`\n"
                        f"Network: {NETWORK}"
                    )

        except Exception as e:
            print(f"  Poll error: {e}")

        time.sleep(POLL_INTERVAL)

# ── Peg-Out Monitor ────────────────────────────────────────────────────────────

def monitor_pegout(rsk_tx_hash: str) -> None:
    state            = load_state()
    alerted_queued   = state.get(f"{rsk_tx_hash}_queued",   False)
    alerted_complete = state.get(f"{rsk_tx_hash}_complete", False)

    print(f"\n  Starting peg-out monitor for {rsk_tx_hash[:22]}...")
    print(f"  Network: {NETWORK} | Required confirmations: {PEGOUT_REQUIRED}\n")

    while True:
        try:
            current_block = with_retry(lambda: w3.eth.block_number)
            receipt       = with_retry(lambda: w3.eth.get_transaction_receipt(rsk_tx_hash))

            if not receipt:
                print_status("PEG-OUT (rBTC → BTC)", {
                    "RSK Tx Hash"   : f"{rsk_tx_hash[:22]}...",
                    "Current Block" : str(current_block),
                    "Status"        : "Pending — not yet mined",
                    "Confirmations" : f"0 / {PEGOUT_REQUIRED}",
                })
            else:
                tx_block     = receipt["blockNumber"]
                confirms     = current_block - tx_block
                remaining    = max(0, PEGOUT_REQUIRED - confirms)
                complete     = confirms >= PEGOUT_REQUIRED

                queued_count = with_retry(
                    lambda: bridge.functions.getQueuedPegoutsCount().call()
                )
                next_batch   = with_retry(
                    lambda: bridge.functions.getNextPegoutCreationBlockNumber().call()
                )
                blocks_to_next = max(0, next_batch - current_block)

                status = (
                    "✓ COMPLETE — BTC broadcast"
                    if complete
                    else f"Processing ({confirms}/{PEGOUT_REQUIRED} RSK blocks)"
                    if confirms >= 10
                    else "Queued — awaiting minimum confirmations"
                )

                print_status("PEG-OUT (rBTC → BTC)", {
                    "RSK Tx Hash"   : f"{rsk_tx_hash[:22]}...",
                    "Tx Block"      : str(tx_block),
                    "Current Block" : str(current_block),
                    "Confirmations" : f"{confirms} / {PEGOUT_REQUIRED}",
                    "Queue Size"    : f"{queued_count} pending pegout(s)",
                    "Next Batch"    : f"{blocks_to_next} blocks" if blocks_to_next > 0 else "Imminent",
                    "Status"        : status,
                    "ETA"           : seconds_to_human(remaining * RSK_BLOCK_TIME) if remaining > 0 else "Done",
                })

                current = load_state()
                current[f"{rsk_tx_hash}_confirms"] = confirms
                save_state(current)

                if confirms >= 10 and not alerted_queued:
                    alerted_queued = True
                    current[f"{rsk_tx_hash}_queued"] = True
                    save_state(current)
                    send_alert(
                        f"🔄 *PowPeg Peg-Out Queued*\n"
                        f"RSK Tx: `{rsk_tx_hash}`\n"
                        f"{confirms} RSK confirmations so far.\n"
                        f"Network: {NETWORK}"
                    )

                if complete and not alerted_complete:
                    alerted_complete = True
                    current[f"{rsk_tx_hash}_complete"] = True
                    save_state(current)
                    send_alert(
                        f"✅ *PowPeg Peg-Out Complete*\n"
                        f"RSK Tx: `{rsk_tx_hash}`\n"
                        f"{PEGOUT_REQUIRED} RSK confirmations reached. BTC broadcast.\n"
                        f"Network: {NETWORK}"
                    )

        except Exception as e:
            print(f"  Poll error: {e}")

        time.sleep(POLL_INTERVAL)

# ── Entry point ────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python monitor.py [pegin|pegout] <txHash> [rskAddress]")
        sys.exit(1)

    mode = sys.argv[1]

    if mode == "pegin":
        if len(sys.argv) < 4:
            print("Usage: python monitor.py pegin <btcTxHash> <rskAddress>")
            sys.exit(1)
        monitor_pegin(sys.argv[2], sys.argv[3])
    elif mode == "pegout":
        monitor_pegout(sys.argv[2])
    else:
        print("Mode must be 'pegin' or 'pegout'")
        sys.exit(1)
