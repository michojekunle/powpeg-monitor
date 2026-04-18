# How to Build a Real-Time PowPeg Bridge Monitor for Rootstock

Moving Bitcoin into Rootstock's ecosystem gives you EVM compatibility, smart contracts, and DeFi — all still backed by Bitcoin's proof-of-work. But the PowPeg bridge is not instant. A native peg-in takes 100 Bitcoin confirmations (~17 hours). A native peg-out waits for 4,000 Rootstock block confirmations (~34 hours). During that window, most developers and users are flying blind.

This tutorial walks you through building a lightweight real-time monitor that tracks peg-in and peg-out transaction status, counts confirmations, estimates time remaining, and optionally fires Telegram or Discord alerts when funds land. The entire system runs from a single script — no backend server required.

The complete code is on GitHub: [github.com/michojekunle/powpeg-monitor](https://github.com/michojekunle/powpeg-monitor)

---

## Understanding the PowPeg

The PowPeg is Rootstock's native Bitcoin two-way peg. It converts BTC to rBTC (peg-in) and rBTC back to BTC (peg-out). The bridge is a precompiled smart contract at a fixed address on Rootstock:

```
0x0000000000000000000000000000000001000006
```

This contract maintains a live SPV view of the Bitcoin blockchain, verifies peg-in requests, and commands peg-outs. Everything you need to monitor is readable from this single address.

### Peg-in flow

1. Send BTC to the current PowPeg federation address (retrieved from `getFederationAddress()` on the Bridge contract)
2. The Bridge watches the Bitcoin chain in SPV mode
3. After 100 Bitcoin block confirmations, the Bridge releases equivalent rBTC to your Rootstock address
4. Estimated time: ~17 hours native, ~20 minutes via Flyover fast mode

### Peg-out flow

1. Send rBTC directly to the Bridge contract address on Rootstock (minimum 0.004 rBTC, gas limit 100,000)
2. The Bridge queues your request — batched peg-outs are processed every ~360 RSK blocks (~3 hours)
3. After 4,000 RSK block confirmations, PowHSMs sign the Bitcoin transaction and broadcast it
4. Estimated time: ~34 hours native

### What the monitor tracks

For peg-in:
- The Bitcoin transaction hash
- Current Bitcoin block height vs the block height when your BTC was confirmed
- `getBtcBlockchainBestChainHeight()` on the Bridge contract for the Bridge's live SPV view

For peg-out:
- The Rootstock transaction hash from when you sent rBTC to the Bridge
- The RSK block when that transaction was included
- Current RSK block from `eth_blockNumber`
- `getQueuedPegoutsCount()` and `getNextPegoutCreationBlockNumber()` for queue state

---

## Prerequisites

- Node.js v18+ (JavaScript) or Python 3.10+ (Python)
- A Rootstock RPC endpoint — free at [dashboard.rpc.rootstock.io](https://dashboard.rpc.rootstock.io) (25,000 req/day) or via [Alchemy](https://alchemy.com)
- A Bitcoin transaction hash (peg-in) or Rootstock transaction hash (peg-out) to monitor
- Optional: Telegram bot token + chat ID, or a Discord webhook URL

---

## Project Setup

```bash
git clone https://github.com/michojekunle/powpeg-monitor.git
cd powpeg-monitor
cp .env.example .env
```

Edit `.env` with your values:

```env
RSK_RPC_URL=https://rpc.testnet.rootstock.io/YOUR_API_KEY
BRIDGE_ADDRESS=0x0000000000000000000000000000000001000006
NETWORK=testnet

# Optional — leave blank to disable alerts
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
DISCORD_WEBHOOK_URL=
```

**JavaScript:**
```bash
npm install
```

**Python:**
```bash
pip install web3 python-dotenv requests
```

---

## The Bridge Contract ABI

You only need five read-only functions. Save this as `bridge-abi.json`:

```json
[
  {
    "name": "getBtcBlockchainBestChainHeight",
    "type": "function",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [{ "name": "", "type": "int32" }]
  },
  {
    "name": "getFederationAddress",
    "type": "function",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [{ "name": "", "type": "string" }]
  },
  {
    "name": "getQueuedPegoutsCount",
    "type": "function",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [{ "name": "", "type": "uint256" }]
  },
  {
    "name": "getNextPegoutCreationBlockNumber",
    "type": "function",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [{ "name": "", "type": "uint256" }]
  },
  {
    "name": "getEstimatedFeesForNextPegOutEvent",
    "type": "function",
    "stateMutability": "view",
    "inputs": [],
    "outputs": [{ "name": "", "type": "uint256" }]
  }
]
```

---

## Building the Monitor: JavaScript

Create `monitor.js`:

```javascript
"use strict";

const { ethers } = require("ethers");
const fs = require("fs");
require("dotenv").config();

// Node 18+ has fetch built-in; fall back to node-fetch for older runtimes
const fetch = globalThis.fetch ?? require("node-fetch").default ?? require("node-fetch");

// ── Config ─────────────────────────────────────────────────────────────────────

const RSK_RPC_URL    = process.env.RSK_RPC_URL;
const BRIDGE_ADDRESS = process.env.BRIDGE_ADDRESS || "0x0000000000000000000000000000000001000006";
const NETWORK        = process.env.NETWORK || "testnet";
const POLL_INTERVAL  = 60_000;
const STATE_FILE     = "./monitor-state.json";

const PEGIN_REQUIRED  = NETWORK === "mainnet" ? 100 : 10;
const PEGOUT_REQUIRED = NETWORK === "mainnet" ? 4000 : 10;
const BTC_BLOCK_TIME  = 600;
const RSK_BLOCK_TIME  = 30;

const BTC_API =
  NETWORK === "mainnet"
    ? "https://blockstream.info/api"
    : "https://blockstream.info/testnet/api";

if (!RSK_RPC_URL) {
  console.error("RSK_RPC_URL is not set in .env");
  process.exit(1);
}

const BRIDGE_ABI = JSON.parse(fs.readFileSync("./bridge-abi.json", "utf8"));
const provider   = new ethers.JsonRpcProvider(RSK_RPC_URL);
const bridge     = new ethers.Contract(BRIDGE_ADDRESS, BRIDGE_ABI, provider);

// ── State persistence ──────────────────────────────────────────────────────────

function loadState() {
  try {
    return fs.existsSync(STATE_FILE)
      ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
      : {};
  } catch {
    return {};
  }
}

function saveState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ── Utilities ──────────────────────────────────────────────────────────────────

function secondsToHuman(seconds) {
  if (seconds < 60)   return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  const h = Math.floor(seconds / 3600);
  const m = Math.round((seconds % 3600) / 60);
  return `${h}h ${m}m`;
}

function printStatus(label, data) {
  console.clear();
  console.log("╔════════════════════════════════════════════╗");
  console.log(`║  PowPeg Monitor — ${NETWORK.toUpperCase().padEnd(24)}║`);
  console.log("╚════════════════════════════════════════════╝");
  console.log(`\n  Type            : ${label}`);
  for (const [k, v] of Object.entries(data)) {
    console.log(`  ${k.padEnd(18)}: ${v}`);
  }
  console.log(`\n  Updated         : ${new Date().toLocaleTimeString()}`);
  console.log("  Press Ctrl+C to stop.\n");
}

// ── Alerts ─────────────────────────────────────────────────────────────────────

async function sendTelegram(message) {
  const token  = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.TELEGRAM_CHAT_ID;
  if (!token || !chatId || token === "your_bot_token") return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text: message, parse_mode: "Markdown" }),
    });
  } catch (err) {
    console.error("Telegram alert failed:", err.message);
  }
}

async function sendDiscord(message) {
  const url = process.env.DISCORD_WEBHOOK_URL;
  if (!url || url.includes("your_webhook")) return;
  try {
    await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: message }),
    });
  } catch (err) {
    console.error("Discord alert failed:", err.message);
  }
}

async function sendAlert(message) {
  console.log(`\n  [ALERT] ${message}\n`);
  await Promise.all([sendTelegram(message), sendDiscord(message)]);
}

// ── Retry wrapper ──────────────────────────────────────────────────────────────

async function withRetry(fn, maxRetries = 3) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      if (i === maxRetries - 1) throw err;
      await new Promise((r) => setTimeout(r, 2000 * Math.pow(2, i)));
    }
  }
}

// ── Peg-In Monitor ─────────────────────────────────────────────────────────────

async function monitorPegin(btcTxHash, rskAddress) {
  const state = loadState();
  let alertedComplete = state[`${btcTxHash}_complete`] || false;

  console.log(`\n  Starting peg-in monitor for ${btcTxHash.slice(0, 20)}...`);
  console.log(`  Network: ${NETWORK} | Required confirmations: ${PEGIN_REQUIRED}\n`);

  async function poll() {
    try {
      const [bridgeBtcHeight, btcRes] = await Promise.all([
        withRetry(() => bridge.getBtcBlockchainBestChainHeight()),
        withRetry(() => fetch(`${BTC_API}/tx/${btcTxHash}`)),
      ]);

      const txData = await btcRes.json();

      if (!txData?.status?.confirmed) {
        printStatus("PEG-IN (BTC → rBTC)", {
          "BTC Tx Hash"      : `${btcTxHash.slice(0, 20)}...`,
          "RSK Address"      : `${rskAddress.slice(0, 20)}...`,
          "Bridge BTC Height": String(bridgeBtcHeight),
          "BTC Status"       : "Unconfirmed (mempool)",
          "Confirmations"    : `0 / ${PEGIN_REQUIRED}`,
          "ETA"              : secondsToHuman(PEGIN_REQUIRED * BTC_BLOCK_TIME),
        });
        return;
      }

      const txBlockHeight    = txData.status.block_height;
      const btcConfirmations = Number(bridgeBtcHeight) - txBlockHeight + 1;
      const remaining        = Math.max(0, PEGIN_REQUIRED - btcConfirmations);
      const complete         = btcConfirmations >= PEGIN_REQUIRED;

      printStatus("PEG-IN (BTC → rBTC)", {
        "BTC Tx Hash"      : `${btcTxHash.slice(0, 20)}...`,
        "RSK Address"      : `${rskAddress.slice(0, 20)}...`,
        "BTC Tx Block"     : String(txBlockHeight),
        "Bridge BTC Height": String(bridgeBtcHeight),
        "Confirmations"    : `${btcConfirmations} / ${PEGIN_REQUIRED}`,
        "Status"           : complete
          ? "✓ COMPLETE — rBTC credited"
          : `Waiting (${btcConfirmations}/${PEGIN_REQUIRED} BTC blocks)`,
        "ETA"              : remaining > 0 ? secondsToHuman(remaining * BTC_BLOCK_TIME) : "Done",
      });

      saveState({ ...loadState(), [`${btcTxHash}_confirms`]: btcConfirmations });

      if (complete && !alertedComplete) {
        alertedComplete = true;
        saveState({ ...loadState(), [`${btcTxHash}_complete`]: true });
        await sendAlert(
          `✅ *PowPeg Peg-In Complete*\nBTC Tx: \`${btcTxHash}\`\nrBTC credited to: \`${rskAddress}\`\nNetwork: ${NETWORK}`
        );
      }
    } catch (err) {
      console.error(`  Poll error: ${err.message}`);
    }
  }

  await poll();
  const timer = setInterval(poll, POLL_INTERVAL);

  process.on("SIGINT", () => {
    clearInterval(timer);
    console.log("\n  Monitor stopped.\n");
    process.exit(0);
  });
}

// ── Peg-Out Monitor ────────────────────────────────────────────────────────────

async function monitorPegout(rskTxHash) {
  const state = loadState();
  let alertedQueued   = state[`${rskTxHash}_queued`]   || false;
  let alertedComplete = state[`${rskTxHash}_complete`]  || false;

  console.log(`\n  Starting peg-out monitor for ${rskTxHash.slice(0, 22)}...`);
  console.log(`  Network: ${NETWORK} | Required confirmations: ${PEGOUT_REQUIRED}\n`);

  async function poll() {
    try {
      const [currentBlock, receipt] = await Promise.all([
        withRetry(() => provider.getBlockNumber()),
        withRetry(() => provider.getTransactionReceipt(rskTxHash)),
      ]);

      if (!receipt) {
        printStatus("PEG-OUT (rBTC → BTC)", {
          "RSK Tx Hash"   : `${rskTxHash.slice(0, 22)}...`,
          "Current Block" : String(currentBlock),
          "Status"        : "Pending — not yet mined",
          "Confirmations" : `0 / ${PEGOUT_REQUIRED}`,
        });
        return;
      }

      const txBlock      = receipt.blockNumber;
      const rskConfirms  = currentBlock - txBlock;
      const remaining    = Math.max(0, PEGOUT_REQUIRED - rskConfirms);
      const complete     = rskConfirms >= PEGOUT_REQUIRED;

      const [queuedCount, nextBatchBlock] = await Promise.all([
        withRetry(() => bridge.getQueuedPegoutsCount()),
        withRetry(() => bridge.getNextPegoutCreationBlockNumber()),
      ]);

      const blocksToNext = Math.max(0, Number(nextBatchBlock) - currentBlock);

      const status = complete
        ? "✓ COMPLETE — BTC broadcast"
        : rskConfirms >= 10
        ? `Processing (${rskConfirms}/${PEGOUT_REQUIRED} RSK blocks)`
        : "Queued — awaiting minimum confirmations";

      printStatus("PEG-OUT (rBTC → BTC)", {
        "RSK Tx Hash"   : `${rskTxHash.slice(0, 22)}...`,
        "Tx Block"      : String(txBlock),
        "Current Block" : String(currentBlock),
        "Confirmations" : `${rskConfirms} / ${PEGOUT_REQUIRED}`,
        "Queue Size"    : `${queuedCount} pending pegout(s)`,
        "Next Batch"    : blocksToNext > 0 ? `${blocksToNext} blocks` : "Imminent",
        "Status"        : status,
        "ETA"           : remaining > 0 ? secondsToHuman(remaining * RSK_BLOCK_TIME) : "Done",
      });

      saveState({ ...loadState(), [`${rskTxHash}_confirms`]: rskConfirms });

      if (rskConfirms >= 10 && !alertedQueued) {
        alertedQueued = true;
        saveState({ ...loadState(), [`${rskTxHash}_queued`]: true });
        await sendAlert(
          `🔄 *PowPeg Peg-Out Queued*\nRSK Tx: \`${rskTxHash}\`\n${rskConfirms} RSK confirmations so far.\nNetwork: ${NETWORK}`
        );
      }

      if (complete && !alertedComplete) {
        alertedComplete = true;
        saveState({ ...loadState(), [`${rskTxHash}_complete`]: true });
        await sendAlert(
          `✅ *PowPeg Peg-Out Complete*\nRSK Tx: \`${rskTxHash}\`\n${PEGOUT_REQUIRED} RSK confirmations reached. BTC broadcast.\nNetwork: ${NETWORK}`
        );
      }
    } catch (err) {
      console.error(`  Poll error: ${err.message}`);
    }
  }

  await poll();
  const timer = setInterval(poll, POLL_INTERVAL);

  process.on("SIGINT", () => {
    clearInterval(timer);
    console.log("\n  Monitor stopped.\n");
    process.exit(0);
  });
}

// ── Entry point ────────────────────────────────────────────────────────────────

const [, , mode, txHash, rskAddress] = process.argv;

if (mode === "pegin") {
  if (!txHash || !rskAddress) {
    console.error("Usage: node monitor.js pegin <btcTxHash> <rskAddress>");
    process.exit(1);
  }
  monitorPegin(txHash, rskAddress);
} else if (mode === "pegout") {
  if (!txHash) {
    console.error("Usage: node monitor.js pegout <rskTxHash>");
    process.exit(1);
  }
  monitorPegout(txHash);
} else {
  console.error("Usage: node monitor.js [pegin|pegout] <txHash> [rskAddress]");
  process.exit(1);
}
```

Run it:

```bash
# Monitor a peg-in
node monitor.js pegin <your-btc-tx-hash> <your-rsk-address>

# Monitor a peg-out
node monitor.js pegout <your-rsk-tx-hash>
```

---

## Building the Monitor: Python

Create `monitor.py`:

```python
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
    state            = load_state()
    alerted_complete = state.get(f"{btc_tx_hash}_complete", False)

    print(f"\n  Starting peg-in monitor for {btc_tx_hash[:20]}...")
    print(f"  Network: {NETWORK} | Required confirmations: {PEGIN_REQUIRED}\n")

    while True:
        try:
            bridge_btc_height = with_retry(
                lambda: bridge.functions.getBtcBlockchainBestChainHeight().call()
            )
            res = with_retry(
                lambda: requests.get(f"{BTC_API}/tx/{btc_tx_hash}", timeout=10)
            )
            tx = res.json()

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
                tx_block  = tx["status"]["block_height"]
                confirms  = bridge_btc_height - tx_block + 1
                remaining = max(0, PEGIN_REQUIRED - confirms)
                complete  = confirms >= PEGIN_REQUIRED

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
                tx_block   = receipt["blockNumber"]
                confirms   = current_block - tx_block
                remaining  = max(0, PEGOUT_REQUIRED - confirms)
                complete   = confirms >= PEGOUT_REQUIRED

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
```

Run it:

```bash
# Monitor a peg-in
python monitor.py pegin <btc-tx-hash> <rsk-address>

# Monitor a peg-out
python monitor.py pegout <rsk-tx-hash>
```

---

## Setting Up Telegram Alerts

1. Open Telegram → search `@BotFather` → `/newbot` → copy your bot token
2. Start a chat with your bot, then visit:
   ```
   https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates
   ```
3. Send your bot a message, then check the JSON response for `"chat": {"id": ...}` — that's your chat ID
4. Add both to `.env`

Test before relying on it:

```bash
node -e "
require('dotenv').config();
fetch('https://api.telegram.org/bot' + process.env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ chat_id: process.env.TELEGRAM_CHAT_ID, text: 'PowPeg monitor test' })
}).then(r => r.json()).then(console.log);
"
```

---

## Setting Up Discord Alerts

1. Server Settings → Integrations → Webhooks → New Webhook → copy the URL
2. Add `DISCORD_WEBHOOK_URL` to `.env`

Test it:

```bash
curl -H "Content-Type: application/json" \
  -d '{"content": "PowPeg monitor test"}' \
  "$DISCORD_WEBHOOK_URL"
```

---

## Testnet Walkthrough

Here's an end-to-end example using real testnet transactions.

### Step 1: Get your RPC key

Go to [dashboard.rpc.rootstock.io](https://dashboard.rpc.rootstock.io) or [alchemy.com](https://alchemy.com), create an API key, and set `NETWORK=testnet` in `.env`.

### Step 2: Confirm the current federation address

The PowPeg federation address rotates when the PowPeg composition changes. Always query it fresh before sending BTC:

```bash
curl -X POST https://rpc.testnet.rootstock.io/YOUR_API_KEY \
  -H "Content-Type: application/json" \
  -d '{
    "jsonrpc": "2.0",
    "method": "eth_call",
    "params": [{
      "to": "0x0000000000000000000000000000000001000006",
      "data": "0x6923fa85"
    }, "latest"],
    "id": 1
  }'
```

The selector `0x6923fa85` is the ABI encoding of `getFederationAddress()`. Decode the hex response as UTF-8 to get the current Bitcoin testnet address.

At the time of writing (April 2026), the testnet federation address is `2N88sMiizxmbb8Y3yA4AtYmL1RxHogWfoHa`. Verify this yourself before sending anything.

### Step 3: Track a peg-in (BTC → rBTC)

Get tBTC from [bitcoinfaucet.uo1.net](https://bitcoinfaucet.uo1.net) and send at least 0.005 tBTC to the federation address from a legacy (non-SegWit) testnet wallet.

Here's a real confirmed testnet peg-in you can run the monitor against:

```
BTC tx: a74918ced40b93d8cf9843cc952db41d233fda569ae60cee240292153a529526
```

```bash
node monitor.js pegin a74918ced40b93d8cf9843cc952db41d233fda569ae60cee240292153a529526 <your-rsk-address>
```

Output:

```
╔════════════════════════════════════════════╗
║  PowPeg Monitor — TESTNET                 ║
╚════════════════════════════════════════════╝

  Type              : PEG-IN (BTC → rBTC)
  BTC Tx Hash       : a74918ced40b93d8cf98...
  RSK Address       : 0x742d35Cc6634C05532...
  BTC Tx Block      : 4918812
  Bridge BTC Height : 4922702
  Confirmations     : 3891 / 10
  Status            : ✓ COMPLETE — rBTC credited
  ETA               : Done

  Updated           : 10:51:00 AM
  Press Ctrl+C to stop.
```

On testnet, 10 confirmations are required instead of 100 — so the wait is about 100 minutes from a fresh transaction.

### Step 4: Track a peg-out (rBTC → BTC)

Send at least 0.004 tRBTC to the Bridge contract address on testnet. Use exactly:
- Gas limit: **100,000**
- Gas price: **0.06 gwei**

Here's a real confirmed testnet peg-out (0.005 rBTC sent to the Bridge at block 7,562,606):

```
RSK tx: 0x7695bb4c1dbaf9840d3cafb3fa539162f5f116e7d74cf25bad604a9dd4669d19
```

```bash
node monitor.js pegout 0x7695bb4c1dbaf9840d3cafb3fa539162f5f116e7d74cf25bad604a9dd4669d19
```

Output:

```
╔════════════════════════════════════════════╗
║  PowPeg Monitor — TESTNET                 ║
╚════════════════════════════════════════════╝

  Type              : PEG-OUT (rBTC → BTC)
  RSK Tx Hash       : 0x7695bb4c1dbaf9840d3c...
  Tx Block          : 7562606
  Current Block     : 7565503
  Confirmations     : 2897 / 10
  Queue Size        : 0 pending pegout(s)
  Next Batch        : 175 blocks
  Status            : ✓ COMPLETE — BTC broadcast
  ETA               : Done

  Updated           : 14:39:03
  Press Ctrl+C to stop.
```

---

## Hardening for Production

The scripts above are solid for development and personal use. For production handling real funds:

**Switch to WebSocket for RSK.** Replace HTTP polling with `WebSocketProvider` and subscribe to new blocks. Latency drops from 60 seconds to under 2 seconds:

```javascript
const wsProvider = new ethers.WebSocketProvider(
  "wss://rpc.testnet.rootstock.io/YOUR_API_KEY"
);

wsProvider.on("block", async (blockNumber) => {
  await checkPegoutConfirmations(rskTxHash, blockNumber);
});
```

**Track multiple transactions.** Refactor the polling loop into a class and run N monitors with `Promise.all` (JS) or `asyncio.gather` (Python).

**Validate the BTC output target.** Before starting a peg-in monitor, verify the transaction actually sends to the current federation address. If the PowPeg composition changed between when you initiated the peg-in and when you started monitoring, the Bridge will never process it:

```javascript
async function validatePeginTarget(btcTxHash, expectedFedAddress) {
  const res  = await fetch(`${BTC_API}/tx/${btcTxHash}`);
  const tx   = await res.json();
  const targeted = (tx.vout || []).some(
    (v) => v.scriptpubkey_address === expectedFedAddress
  );
  if (!targeted) {
    throw new Error(
      `${btcTxHash} does not send to federation address ${expectedFedAddress}. ` +
      `Check powpeg.rootstock.io for the current address.`
    );
  }
}
```

**Watch RPC rate limits.** The free RPC tier allows 25,000 requests/day. At a 60-second poll interval the monitor uses ~1,440 requests/day — well within limits. If you tighten the interval, the retry wrapper already handles transient errors with exponential backoff (2s, 4s, 8s).

---

## Key Numbers

| Parameter | Mainnet | Testnet |
|-----------|---------|---------|
| Peg-in BTC confirmations | 100 | 10 |
| Peg-out RSK confirmations | 4,000 | 10 |
| Minimum peg-in | 0.005 BTC | 0.005 tBTC |
| Minimum peg-out | 0.004 rBTC | 0.004 tRBTC |
| Peg-out gas limit | 100,000 | 100,000 |
| Peg-out batch window | ~360 RSK blocks (~3h) | same |
| Native peg-in time | ~17 hours | ~100 min |
| Native peg-out time | ~34 hours | ~5 min |
| Flyover peg-in time | ~20 minutes | ~20 min |
| Bridge address | `0x0000000000000000000000000000000001000006` | same |

---

## Useful RPC Calls for Debugging

**Bridge's current BTC chain height** (`getBtcBlockchainBestChainHeight`):

```bash
curl -X POST https://rpc.testnet.rootstock.io/YOUR_API_KEY \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"0x0000000000000000000000000000000001000006","data":"0xf97c45f3"},"latest"],"id":1}'
```

**Queued peg-out count** (`getQueuedPegoutsCount`):

```bash
curl -X POST https://rpc.testnet.rootstock.io/YOUR_API_KEY \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_call","params":[{"to":"0x0000000000000000000000000000000001000006","data":"0x0ea6e2e8"},"latest"],"id":1}'
```

**Current Rootstock block**:

```bash
curl -X POST https://rpc.testnet.rootstock.io/YOUR_API_KEY \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","method":"eth_blockNumber","params":[],"id":1}'
```

---

## What to Build Next

With a working monitor in place:

- **Add Flyover peg-in support.** Flyover uses the Liquidity Bridge Contract (LBC) and needs only 2 Bitcoin confirmations. The Flyover SDK provides quote and status endpoints your monitor can wrap.

- **Build a dashboard.** Expose the polling logic via a simple Express or FastAPI server with a React frontend showing live progress bars for all active bridge transactions.

- **Subscribe to Bridge events.** Use `eth_subscribe` with a logs filter on the Bridge address to build a production-grade indexer instead of polling.

---

*Written for Rootstock mainnet block 8,532,255 and testnet (April 2026). Bridge contract address and confirmation thresholds verified as of this date. Always query `getFederationAddress()` from the Bridge contract before sending BTC — the PowPeg composition changes periodically.*
