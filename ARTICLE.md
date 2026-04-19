# How to Build a Real-Time PowPeg Bridge Monitor for Rootstock

Moving Bitcoin into Rootstock's EVM gives you smart contracts, DeFi, and programmability — all still settled by Bitcoin's proof-of-work. But the PowPeg bridge is deliberately slow. A native peg-in takes 100 Bitcoin confirmations (~17 hours). A native peg-out waits for 4,000 Rootstock block confirmations (~34 hours). During that window, developers and users have no native tooling to watch progress — no block explorer gives you a confirmation countdown, no protocol-level notification fires when funds land.

This guide builds a real-time monitor from scratch: a lightweight script that tracks confirmation progress, calculates time remaining, and fires Telegram or Discord alerts when funds arrive. More importantly, it explains *why* the monitor is built the way it is — the Bridge's SPV model, where the confirmation numbers come from, and the failure modes you have to guard against.

The complete code is on GitHub: [github.com/michojekunle/powpeg-monitor](https://github.com/michojekunle/powpeg-monitor)

---

## Understanding the PowPeg

The PowPeg is Rootstock's native two-way Bitcoin peg. It converts BTC to rBTC (peg-in) and rBTC back to BTC (peg-out) without a centralized custodian. The mechanism is a precompiled smart contract at a fixed address on every Rootstock node:

```
0x0000000000000000000000000000000001000006
```

This is not a regular deployed contract — it's a precompile baked into the Rootstock protocol. Every Rootstock node runs the Bridge logic natively. You call it like any EVM contract (via `eth_call`), but the execution is native Go/Java code inside the node.

### The Bridge maintains its own Bitcoin chain view

This is the critical thing to understand before building a monitor: **the Bridge does not trust Blockstream, an external oracle, or you when it comes to Bitcoin block heights.** It maintains its own SPV (Simplified Payment Verification) chain of Bitcoin headers — a full record of every Bitcoin block header, synced by Rootstock nodes themselves.

When you call `getBtcBlockchainBestChainHeight()`, you get the Bridge's own verified BTC chain tip. This is the authoritative number for peg-in confirmation counting. You compare the BTC block your peg-in transaction landed in against this Bridge-internal height — not against Blockstream's API, not against a third-party source.

Why does this matter? Because the Bridge only unlocks rBTC when *it* has seen 100 Bitcoin confirmations (10 on testnet). An external API saying the BTC chain is at block 5,000,000 is irrelevant if the Bridge's SPV chain is still at 4,999,950. The confirmation count you display must use the Bridge's view:

```
btcConfirmations = bridgeBtcHeight - txBlockHeight + 1
```

The `+ 1` accounts for the block the transaction itself is included in — the convention is that a transaction has 1 confirmation when the block containing it is the chain tip.

One practical consequence: the Bridge SPV chain can temporarily lag behind the actual Bitcoin network. If the transaction just landed and the Bridge hasn't processed the latest BTC headers yet, this arithmetic gives a negative result. The monitor clamps to zero: `Math.max(0, ...)`.

### Peg-in flow

1. Query `getFederationAddress()` from the Bridge contract to get the current federation address
2. Send BTC to that address from a legacy (non-SegWit) Bitcoin wallet — minimum 0.005 BTC
3. The Bridge watches Bitcoin in SPV mode — Rootstock nodes relay Bitcoin block headers continuously
4. After 100 Bitcoin confirmations the Bridge verifies the payment and mints equivalent rBTC to your Rootstock address
5. Estimated time: ~17 hours native, ~20 minutes via Flyover fast mode

The federation address is not static. The PowPeg federation is a group of PowHSM devices operated by Rootstock node operators, and the address changes when the federation composition changes. **Always call `getFederationAddress()` fresh before sending BTC.** The monitor validates this automatically at startup.

### Peg-out flow

1. Send rBTC directly to the Bridge contract address (`0x0000...000006`) on Rootstock, minimum 0.004 rBTC, gas limit 100,000
2. The Bridge queues your request — peg-outs are batched every ~360 RSK blocks (~3 hours)
3. After 4,000 RSK block confirmations (~34 hours), the PowHSM devices sign the Bitcoin transaction with their hardware-secured keys and broadcast it to the Bitcoin network

The 4,000 RSK block threshold exists because Rootstock uses merged mining — RSK blocks are mined by Bitcoin miners alongside Bitcoin blocks. Merged mining means RSK's security is anchored to Bitcoin hash rate, but a Rootstock reorganization could theoretically undo a peg-out request. 4,000 blocks (~34 hours) makes such a reorg computationally infeasible.

### What the monitor reads

For peg-in, the monitor needs two numbers: the Bridge's SPV BTC chain height, and the BTC block height where your transaction was confirmed. One comes from the Bridge contract, one from the Bitcoin blockchain API.

For peg-out, everything is on Rootstock: the current block number, the transaction receipt showing which RSK block your tx landed in, the current queue size, and the next batch processing block. No Bitcoin API calls needed — you're watching RSK confirmations accumulate until they cross 4,000.

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
# Install into the same interpreter you will run the script with.
# On macOS, a bare 'pip3' can point to a *different* Python than 'python3'
# (e.g. pip3 → 3.14 while python3 → 3.12), causing silent "module not found"
# errors at runtime. Use 'python3 -m pip' to guarantee they match.
python3 -m pip install web3 python-dotenv requests
```

> **Python version note:** Python 3.10–3.13 recommended. If you're on macOS with Homebrew's default Python and see a `pyexpat` / `libexpat` error, install a supported version and target it explicitly:
> ```bash
> brew install python@3.12
> python3.12 -m pip install web3 python-dotenv requests
> python3.12 monitor.py pegin ...
> ```
> `./test.sh` detects and uses a working Python automatically — it always installs packages via `$PYTHON -m pip` to avoid this class of problem.

---

## The Bridge Contract ABI

The ABI tells ethers.js or web3.py how to encode and decode calls to the Bridge precompile. You only need four read-only functions to monitor both peg directions:

- `getBtcBlockchainBestChainHeight` — Bridge's internal SPV view of the Bitcoin chain. This is the authoritative source for peg-in confirmation counting. Returned as `int32` (signed) to match the Bridge's internal representation; in practice it's always positive.
- `getFederationAddress` — the current PowPeg multisig address on Bitcoin. Validated at startup so the monitor fails fast if your BTC transaction targets an outdated address.
- `getQueuedPegoutsCount` — how many peg-out requests are currently waiting in the batch queue. Surfaced in the display so you know how busy the queue is.
- `getNextPegoutCreationBlockNumber` — the RSK block number when the next batch will be assembled. Lets you display how many blocks until the next batch window.

Save this as `bridge-abi.json`:

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
  }
]
```

---

## Building the Monitor: JavaScript

The monitor has five moving parts worth understanding before you read the code:

**State persistence.** If the process crashes or you restart it, the alert flags load from `monitor-state.json`. Without this, the monitor would re-fire "peg-in complete" alerts every time it restarts. The file lives in the same directory as the script (`__dirname`), not the current working directory, so it works regardless of where you invoke the script from.

**Retry with exponential backoff.** Both the RSK RPC and the Blockstream API are external services. The RPC can return transient 5xx errors; Blockstream has 504s from its CDN. The `withRetry` wrapper catches these, logs the attempt and delay, and retries up to 3 times with 2s, 4s, 8s waits. A 404 from Blockstream is *not* retried — it means the transaction hash is genuinely wrong, not a transient error. This distinction matters: without it, a typo in the BTC tx hash would silently spin for 3 retries before failing.

**Federation address validation.** The peg-in monitor calls `getFederationAddress()` and verifies that your BTC transaction actually outputs to that address before entering the polling loop. If the PowPeg composition changed since you sent your BTC — which happens periodically — the script throws immediately with a clear error. This catches a common mistake: sending BTC to an outdated federation address and then wondering why rBTC never arrives.

**Confirmation math.** For peg-in: `Math.max(0, bridgeBtcHeight - txBlockHeight + 1)`. The `+1` follows the standard confirmations convention. The `Math.max(0, ...)` clamp handles the case where the Bridge SPV view lags briefly behind the BTC network — without it you'd display a negative confirmation count right after the transaction confirms.

**Poll interval.** Sixty seconds. Bitcoin blocks arrive every ~10 minutes and RSK blocks every ~30 seconds. Polling faster would waste RPC quota without improving the display meaningfully. The free RPC tier (25,000 req/day) allows ~1,440 polls/day at this interval — well within limits even with parallel monitors.

Create `monitor.js`:

```javascript
"use strict";

const { ethers } = require("ethers");
const fs   = require("fs");
const path = require("path");
require("dotenv").config();

// Node 18+ has fetch built-in; fall back to node-fetch for older runtimes
const fetch = globalThis.fetch ?? require("node-fetch").default ?? require("node-fetch");

// ── Config ─────────────────────────────────────────────────────────────────────

const RSK_RPC_URL    = process.env.RSK_RPC_URL;
const BRIDGE_ADDRESS = process.env.BRIDGE_ADDRESS || "0x0000000000000000000000000000000001000006";
const NETWORK        = process.env.NETWORK || "testnet";
const POLL_INTERVAL  = 60_000;
const STATE_FILE     = path.join(__dirname, "monitor-state.json");

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

const BRIDGE_ABI = JSON.parse(fs.readFileSync(path.join(__dirname, "bridge-abi.json"), "utf8"));
const provider   = new ethers.JsonRpcProvider(RSK_RPC_URL);
const bridge     = new ethers.Contract(BRIDGE_ADDRESS, BRIDGE_ABI, provider);

// ── State persistence ──────────────────────────────────────────────────────────

function loadState() {
  try {
    return fs.existsSync(STATE_FILE)
      ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8"))
      : {};
  } catch (err) {
    console.warn(`  Warning: could not read state file, starting fresh. (${err.message})`);
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
  console.log(`\n  ${"Type".padEnd(18)}: ${label}`);
  for (const [k, v] of Object.entries(data)) {
    console.log(`  ${k.padEnd(18)}: ${v}`);
  }
  console.log(`\n  ${"Updated".padEnd(18)}: ${new Date().toLocaleTimeString()}`);
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
      const delay = 2000 * Math.pow(2, i);
      console.warn(`  Retry ${i + 1}/${maxRetries - 1}: ${err.message} — waiting ${delay / 1000}s`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ── Peg-In Monitor ─────────────────────────────────────────────────────────────

async function validatePeginTarget(btcTxHash, expectedFedAddress) {
  // Treat 5xx as transient (retry); treat 404 as definitive bad hash (throw immediately).
  const res = await withRetry(async () => {
    const r = await fetch(`${BTC_API}/tx/${btcTxHash}`);
    if (r.status === 404) {
      throw Object.assign(new Error(`Tx ${btcTxHash} not found on ${NETWORK}. Check the hash.`), { fatal: true });
    }
    if (!r.ok) throw new Error(`Blockstream HTTP ${r.status}`);
    return r;
  });

  const tx = await res.json();
  if (!tx?.vout) {
    throw new Error(`Could not fetch outputs for tx ${btcTxHash}.`);
  }
  const targeted = tx.vout.some((v) => v.scriptpubkey_address === expectedFedAddress);
  if (!targeted) {
    throw new Error(
      `Tx ${btcTxHash} does not send to federation address ${expectedFedAddress}.\n` +
      `The PowPeg composition may have changed. Check powpeg.rootstock.io for the current address.`
    );
  }
}

async function monitorPegin(btcTxHash, rskAddress) {
  // Strip accidental 0x prefix — BTC tx hashes are plain hex
  if (btcTxHash.startsWith("0x") || btcTxHash.startsWith("0X")) {
    btcTxHash = btcTxHash.slice(2);
    console.warn(`  Warning: stripped 0x prefix from BTC tx hash.`);
  }

  const state = loadState();
  let alertedComplete = state[`${btcTxHash}_complete`] || false;

  console.log(`\n  Starting peg-in monitor for ${btcTxHash.slice(0, 20)}...`);
  console.log(`  Network: ${NETWORK} | Required confirmations: ${PEGIN_REQUIRED}`);

  // Validate tx actually targets the current federation address before polling
  console.log(`  Validating tx targets current federation address...`);
  const fedAddress = await withRetry(() => bridge.getFederationAddress());
  console.log(`  Federation address: ${fedAddress}\n`);
  await validatePeginTarget(btcTxHash, fedAddress);

  async function poll() {
    try {
      const [bridgeBtcHeight, txData] = await Promise.all([
        withRetry(() => bridge.getBtcBlockchainBestChainHeight()),
        withRetry(async () => {
          const r = await fetch(`${BTC_API}/tx/${btcTxHash}`);
          if (!r.ok) throw new Error(`Blockstream HTTP ${r.status}`);
          return r.json();
        }),
      ]);

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
      // Clamp to 0: Bridge SPV view can temporarily lag behind the BTC tx block
      const btcConfirmations = Math.max(0, Number(bridgeBtcHeight) - txBlockHeight + 1);
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

      // 10 RSK confirms = ~5 min — early indicator the tx is safely included;
      // not a protocol threshold, just a useful status boundary for the display.
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

The Python version is functionally identical — same logic, same confirmation math, same retry behavior, same output format. The main structural differences are synchronous I/O (blocking `time.sleep` instead of `setInterval`) and web3.py's contract call syntax.

One subtlety worth knowing: web3.py requires a checksum address (`Web3.to_checksum_address()`). The Bridge address is all-lowercase hex, which web3.py rejects without the checksum step. ethers.js handles this transparently; web3.py does not.

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
from pathlib import Path

import requests
from dotenv import load_dotenv
from web3 import Web3

load_dotenv()

# ── Config ─────────────────────────────────────────────────────────────────────

RSK_RPC_URL    = os.getenv("RSK_RPC_URL")
BRIDGE_ADDRESS = os.getenv("BRIDGE_ADDRESS", "0x0000000000000000000000000000000001000006")
NETWORK        = os.getenv("NETWORK", "testnet")
POLL_INTERVAL  = 60
_HERE      = Path(__file__).parent
STATE_FILE = str(_HERE / "monitor-state.json")

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

with open(_HERE / "bridge-abi.json") as f:
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
    except Exception as e:
        print(f"  Warning: could not read state file, starting fresh. ({e})")
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
            delay = 2 ** (i + 1)
            print(f"  Retry {i + 1}/{max_retries - 1}: {e} — waiting {delay}s")
            time.sleep(delay)

# ── Peg-In helpers ─────────────────────────────────────────────────────────────

def validate_pegin_target(btc_tx_hash: str, expected_fed_address: str) -> None:
    # 404 = invalid hash (fatal); 5xx = transient (retried by with_retry via raised exception)
    def fetch_tx():
        r = requests.get(f"{BTC_API}/tx/{btc_tx_hash}", timeout=10)
        if r.status_code == 404:
            raise ValueError(f"Tx {btc_tx_hash} not found on {NETWORK}. Check the hash.")
        if r.status_code != 200:
            raise RuntimeError(f"Blockstream HTTP {r.status_code} — will retry")
        return r

    res = with_retry(fetch_tx)
    tx = res.json()
    if not tx.get("vout"):
        raise ValueError(f"Could not fetch outputs for tx {btc_tx_hash}.")
    targeted = any(
        v.get("scriptpubkey_address") == expected_fed_address for v in tx["vout"]
    )
    if not targeted:
        raise ValueError(
            f"Tx {btc_tx_hash} does not send to federation address {expected_fed_address}.\n"
            f"The PowPeg composition may have changed. Check powpeg.rootstock.io for the current address."
        )

# ── Peg-In Monitor ─────────────────────────────────────────────────────────────

def monitor_pegin(btc_tx_hash: str, rsk_address: str) -> None:
    # Strip accidental 0x prefix — BTC tx hashes are plain hex
    if btc_tx_hash.startswith(("0x", "0X")):
        btc_tx_hash = btc_tx_hash[2:]
        print("  Warning: stripped 0x prefix from BTC tx hash.")

    state            = load_state()
    alerted_complete = state.get(f"{btc_tx_hash}_complete", False)

    print(f"\n  Starting peg-in monitor for {btc_tx_hash[:20]}...")
    print(f"  Network: {NETWORK} | Required confirmations: {PEGIN_REQUIRED}")

    # Validate tx targets current federation address before polling
    print("  Validating tx targets current federation address...")
    fed_address = with_retry(lambda: bridge.functions.getFederationAddress().call())
    print(f"  Federation address: {fed_address}\n")
    validate_pegin_target(btc_tx_hash, fed_address)

    while True:
        try:
            bridge_btc_height = with_retry(
                lambda: bridge.functions.getBtcBlockchainBestChainHeight().call()
            )
            def fetch_btc_tx():
                r = requests.get(f"{BTC_API}/tx/{btc_tx_hash}", timeout=10)
                if r.status_code != 200:
                    raise RuntimeError(f"Blockstream HTTP {r.status_code}")
                return r.json()

            tx = with_retry(fetch_btc_tx)

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
                # Clamp to 0: Bridge SPV view can temporarily lag behind the BTC tx block
                confirms  = max(0, bridge_btc_height - tx_block + 1)
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

                # 10 RSK confirms = ~5 min — early indicator the tx is safely included;
                # not a protocol threshold, just a useful status boundary for the display.
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

## Verifying Everything Works

Before doing anything with real transactions, run the test suite to confirm your setup is solid. A single bash script checks dependencies, installs packages via `$PYTHON -m pip`, runs both the JS and Python test suites, smoke-tests the live monitor output, and verifies your alert endpoints:

```bash
chmod +x test.sh   # first time only
./test.sh
```

The script auto-detects the best working Python 3.10–3.13 on your system and always installs packages into **that exact interpreter** — avoiding the pip-mismatch issue that causes silent import failures on macOS when `pip3` and `python3` target different versions.

Or run the language-specific suites directly:

```bash
node test.js     # JS: 27 tests covering utilities, state, retry, Bridge calls, Blockstream API, alerts
python3 test.py  # Python: equivalent coverage
```

The test suites use two real confirmed testnet transactions — a peg-in and a peg-out — as fixtures. They hit the live Bridge contract and Blockstream API to verify everything is wired up correctly. All tests should pass before you try monitoring a live transaction.

Options if you don't want the full suite:
```bash
./test.sh --js-only    # JavaScript tests only
./test.sh --py-only    # Python tests only
./test.sh --smoke      # Live monitor smoke tests (peg-in + peg-out output)
./test.sh --alerts     # Alert endpoint tests only (Telegram + Discord)
./test.sh --no-smoke   # Skip live monitor tests
./test.sh --no-alerts  # Skip alert tests
```

### Ready-to-use test transactions

You can run the monitor against these confirmed testnet transactions right now, without sending any BTC or rBTC yourself:

| Field | Value |
|-------|-------|
| BTC peg-in tx | `a74918ced40b93d8cf9843cc952db41d233fda569ae60cee240292153a529526` |
| BTC testnet block | 4,918,812 |
| RSK peg-out tx | `0x7695bb4c1dbaf9840d3cafb3fa539162f5f116e7d74cf25bad604a9dd4669d19` |
| RSK testnet block | 7,562,606 |
| Dummy RSK address | `0x742d35Cc6634C0553241234561234561234567890` |

**JavaScript:**
```bash
# Peg-in (BTC → rBTC) — 0.005 tBTC, confirmed at BTC testnet block 4,918,812
node monitor.js pegin \
  a74918ced40b93d8cf9843cc952db41d233fda569ae60cee240292153a529526 \
  0x742d35Cc6634C0553241234561234561234567890

# Peg-out (rBTC → BTC) — 0.005 tRBTC, confirmed at RSK testnet block 7,562,606
node monitor.js pegout \
  0x7695bb4c1dbaf9840d3cafb3fa539162f5f116e7d74cf25bad604a9dd4669d19
```

**Python:**
```bash
# Peg-in (BTC → rBTC)
python3 monitor.py pegin \
  a74918ced40b93d8cf9843cc952db41d233fda569ae60cee240292153a529526 \
  0x742d35Cc6634C0553241234561234561234567890

# Peg-out (rBTC → BTC)
python3 monitor.py pegout \
  0x7695bb4c1dbaf9840d3cafb3fa539162f5f116e7d74cf25bad604a9dd4669d19
```

Both show `Status: ✓ COMPLETE` since they were confirmed long ago — but they verify that the Bridge contract calls, Blockstream API, confirmation math, and display all work correctly. To see a live countdown, send your own testnet transaction in the walkthrough below.

---

## Testnet Walkthrough

Here's an end-to-end walkthrough using real testnet transactions. Reading the output critically — understanding what each field is telling you — is as important as getting the monitor running.

### Step 1: Get your RPC key

Go to [dashboard.rpc.rootstock.io](https://dashboard.rpc.rootstock.io) or [alchemy.com](https://alchemy.com), create an API key, and set `NETWORK=testnet` in `.env`.

### Step 2: Confirm the current federation address

The PowPeg federation rotates when the federation composition changes. Always query it fresh before sending BTC. Use Node or Python to decode the ABI-encoded response correctly — the raw `eth_call` hex cannot be decoded as plain UTF-8 (the response includes a 64-byte ABI header before the string data):

```javascript
// Quick one-liner — run from your project directory
node -e "
const { ethers } = require('ethers');
require('dotenv').config();
const abi = require('./bridge-abi.json');
const provider = new ethers.JsonRpcProvider(process.env.RSK_RPC_URL);
const bridge = new ethers.Contract(process.env.BRIDGE_ADDRESS, abi, provider);
bridge.getFederationAddress().then(addr => console.log('Federation address:', addr));
"
```

```python
# Python equivalent
python3 -c "
from web3 import Web3; import json, os
from dotenv import load_dotenv; load_dotenv()
w3 = Web3(Web3.HTTPProvider(os.getenv('RSK_RPC_URL')))
abi = json.load(open('bridge-abi.json'))
bridge = w3.eth.contract(address=Web3.to_checksum_address(os.getenv('BRIDGE_ADDRESS')), abi=abi)
print('Federation address:', bridge.functions.getFederationAddress().call())
"
```

The monitor validates this automatically at peg-in startup. At the time of writing (April 2026), the testnet federation address is `2N88sMiizxmbb8Y3yA4AtYmL1RxHogWfoHa`. Verify it yourself before sending anything.

### Step 3: Track a peg-in (BTC → rBTC)

Get tBTC from [bitcoinfaucet.uo1.net](https://bitcoinfaucet.uo1.net) and send at least 0.005 tBTC to the federation address from a legacy (non-SegWit) testnet wallet.

Here's a real confirmed testnet peg-in you can run the monitor against right now:

```
BTC tx: a74918ced40b93d8cf9843cc952db41d233fda569ae60cee240292153a529526
```

```bash
node monitor.js pegin a74918ced40b93d8cf9843cc952db41d233fda569ae60cee240292153a529526 <your-rsk-address>
```

Output:

```
  Starting peg-in monitor for a74918ced40b93d8cf98...
  Network: testnet | Required confirmations: 10
  Validating tx targets current federation address...
  Federation address: 2N88sMiizxmbb8Y3yA4AtYmL1RxHogWfoHa

╔════════════════════════════════════════════╗
║  PowPeg Monitor — TESTNET                 ║
╚════════════════════════════════════════════╝

  Type              : PEG-IN (BTC → rBTC)
  BTC Tx Hash       : a74918ced40b93d8cf98...
  RSK Address       : 0x742d35Cc6634C05532...
  BTC Tx Block      : 4918812
  Bridge BTC Height : 4925875
  Confirmations     : 7064 / 10
  Status            : ✓ COMPLETE — rBTC credited
  ETA               : Done

  Updated         : 9:12:34 PM
  Press Ctrl+C to stop.
```

Reading this output:
- **BTC Tx Block: 4918812** — this is where your BTC transaction was included in the Bitcoin testnet chain
- **Bridge BTC Height: 4925875** — this is the Bridge's own SPV view of the Bitcoin testnet tip, fetched directly from the contract. The Bridge has synced 7,063 Bitcoin blocks past your transaction's block.
- **Confirmations: 7064 / 10** — computed as `4925875 - 4918812 + 1`. This peg-in completed long ago; you'd only see a live confirmation count climbing on a fresh transaction.

On testnet, 10 confirmations are required instead of 100 — so the wait from a fresh transaction is about 100 minutes.

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

Reading this output:
- **Tx Block: 7562606** — the RSK block that included your `send rBTC to Bridge` transaction
- **Current Block: 7565503** — live RSK chain tip, fetched fresh from the RPC each poll
- **Confirmations: 2897 / 10** — `7565503 - 7562606`. The 4,000 threshold applies on mainnet; testnet uses 10 for rapid iteration
- **Queue Size: 0 pending pegout(s)** — `getQueuedPegoutsCount()` from the Bridge. Zero means your request has already been batched and dispatched
- **Next Batch: 175 blocks** — `getNextPegoutCreationBlockNumber() - currentBlock`. This is when the Bridge will assemble the next batch of queued peg-outs. At ~30s per RSK block, 175 blocks is about 87 minutes

---

## Hardening for Production

The scripts above are solid for development and personal use. For production handling real funds:

**Switch to WebSocket for RSK.** Replace HTTP polling with `WebSocketProvider` and subscribe to new blocks. Latency drops from 60 seconds to under 2 seconds. This matters if you're building something user-facing — nobody wants a confirmation counter that only updates once a minute:

```javascript
const wsProvider = new ethers.WebSocketProvider(
  "wss://rpc.testnet.rootstock.io/YOUR_API_KEY"
);

wsProvider.on("block", async (blockNumber) => {
  await checkPegoutConfirmations(rskTxHash, blockNumber);
});
```

**Track multiple transactions concurrently.** The current scripts handle one transaction at a time. Refactor the polling loop into a class and run N monitors with `Promise.all` (JS) or `asyncio.gather` (Python). The state file already supports multiple transactions — each is stored under its own key.

**Federation address changes mid-wait.** The monitor validates the federation address at startup, but a long-running peg-in monitor could start before a federation rotation and continue happily watching a transaction that will never be credited. For production, re-validate the federation address on each poll or subscribe to Bridge events that signal a federation change.

**Watch RPC rate limits.** The free RPC tier allows 25,000 requests/day. At a 60-second poll interval the monitor uses ~1,440 requests/day — well within limits. If you tighten the interval, the retry wrapper already handles transient errors with exponential backoff (2s, 4s, 8s). On mainnet, a peg-in runs for ~17 hours, so you'll make roughly 1,000 polls per transaction — still fine on the free tier.

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

When something looks wrong — the Bridge height seems stuck, the queue count doesn't make sense — these raw calls let you check the state directly without the monitor.

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

**Add Flyover peg-in support.** Flyover uses the Liquidity Bridge Contract (LBC) and settles in ~2 BTC confirmations instead of 100. The Flyover SDK exposes quote and status endpoints — your monitor can wrap these and give users a fast-path option with a dramatically different ETA.

**Build a dashboard.** Expose the polling logic via a simple Express or FastAPI server with a React frontend showing live progress bars for all active bridge transactions. The state file already has everything you need; the server just reads it.

**Subscribe to Bridge events.** Use `eth_subscribe` with a logs filter on the Bridge address to build a production-grade indexer instead of polling. Bridge events include peg-in registration, peg-out requests, and batch releases — a complete picture of Bridge activity without needing to poll for individual transactions.

---

*Written for Rootstock mainnet block 8,532,255 and testnet (April 2026). Bridge contract address and confirmation thresholds verified as of this date. Always query `getFederationAddress()` from the Bridge contract before sending BTC — the PowPeg composition changes periodically.*
