# Monitor the Rootstock PowPeg Bridge: Track Peg-Ins and Peg-Outs in Near Real-Time

Hi builders, welcome to this step-by-step tutorial where we'll learn how to build a polling-based PowPeg bridge monitor that tracks BTC↔rBTC transfers as they confirm — block by block.

By the end of this tutorial, you'll have a **working monitor** that:

- Displays near real-time confirmation counts and ETAs for both peg-ins and peg-outs (polling every 60 seconds)
- Fires **Telegram and Discord alerts** the moment your transfer completes
- Persists alert state across restarts so you never get a duplicate notification
- Validates every input up front and handles transient RPC errors with automatic retries

The complete code is on GitHub: [github.com/michojekunle/powpeg-monitor](https://github.com/michojekunle/powpeg-monitor)

Let's dive in and see how Rootstock's PowPeg enables decentralized Bitcoin bridging — and how to watch it in near real-time.

---

## What Is the PowPeg?

The **PowPeg** is Rootstock's native two-way Bitcoin peg. It converts BTC to rBTC (peg-in) and rBTC back to BTC (peg-out) without a centralized custodian. The entire mechanism lives in a precompiled smart contract baked into every Rootstock node:

```
0x0000000000000000000000000000000001000006
```

This is not a regular deployed contract — it's a **precompile**, native code that executes inside the Rootstock protocol itself. You call it exactly like any EVM contract via `eth_call`, but the execution happens at the node level, not in the EVM.

Key properties of the PowPeg:

- **Trust-minimized** — No single custodian holds your BTC. The federation is a set of PowHSM hardware devices whose keys cannot be extracted, even by operators.
- **Merged-mined** — Rootstock blocks are produced by Bitcoin miners alongside Bitcoin blocks, sharing hash rate. This integrates Rootstock into the Bitcoin mining ecosystem, though Rootstock maintains its own consensus rules and security model distinct from Bitcoin's.
- **SPV-verified** — The Bridge maintains its own internal chain of Bitcoin block headers. It does not trust external oracles or APIs — it verifies Bitcoin block headers itself.
- **Fully on-chain** — All state (confirmation counts, queue depth, next batch block) is readable from the Bridge contract at any time.

---

## Why Build a Bridge Monitor?

The PowPeg is deliberately slow:

| Direction            | Mainnet confirmations | Mainnet estimate | Testnet confirmations | Testnet estimate |
| -------------------- | --------------------- | ---------------- | --------------------- | ---------------- |
| Peg-in (BTC → rBTC)  | 100 BTC blocks        | ~17 hours        | 10 BTC blocks         | ~100 min         |
| Peg-out (rBTC → BTC) | 4,000 RSK blocks      | ~34 hours        | 10 RSK blocks         | ~5 min           |

During that window, there's no native tooling to watch progress — no block explorer gives you a confirmation countdown, and no protocol-level notification fires when funds land.

A monitor solves three real problems:

- **Visibility** — Know exactly where your transfer is, not just "pending" or "complete."
- **Peace of mind** — Get alerted the moment funds arrive rather than checking manually every few hours.
- **Developer tooling** — When building dApps on Rootstock, you need to programmatically track bridge state. This monitor is a working reference for exactly that.

---

## What This Guide Covers

By the end, you'll have built and understood:

- A **JavaScript monitor** (`monitor.js`) using ethers v6 and the Blockstream API
- A **Python monitor** (`monitor.py`) using web3.py — functionally identical to the JS version
- A **test suite** (`test.js` + `test.py`) covering validation, retry logic, state persistence, and alert deduplication
- **Telegram and Discord alert integration** with concurrent dispatch
- All the **defensive patterns** that make a production monitor reliable: `FatalError` classification, atomic file writes, input validation, and NETWORK env validation

---

## Prerequisites

- **Node.js v18+** (JavaScript) or **Python 3.10–3.13** (Python)
- A **Rootstock RPC endpoint** — free at [dashboard.rpc.rootstock.io](https://dashboard.rpc.rootstock.io) (25,000 req/day) or via [Alchemy](https://alchemy.com)
- A **BTC transaction hash** (peg-in) or **RSK transaction hash** (peg-out) to monitor
- Optional: Telegram bot token + chat ID, or a Discord webhook URL

---

## Section 1: Project Setup

### 1.1 Clone and Install

```bash
git clone https://github.com/michojekunle/powpeg-monitor.git
cd powpeg-monitor
cp .env.example .env
```

**JavaScript:**

```bash
npm install
```

**Python:**

```bash
# Use 'python3 -m pip' — not a bare 'pip3'. On macOS, pip3 can point to a
# different Python than python3, causing silent "module not found" errors at runtime.
python3 -m pip install web3 python-dotenv requests
```

> **Python version note:** Python 3.10–3.13 is recommended. Python 3.14 has a known `pyexpat`/`libexpat` incompatibility on macOS that breaks `web3` installation. If you hit this, use:
>
> ```bash
> brew install python@3.12
> python3.12 -m pip install web3 python-dotenv requests
> python3.12 monitor.py pegin ...
> ```

### 1.2 Configure Environment

Edit `.env` with your values:

```env
RSK_RPC_URL=https://rpc.testnet.rootstock.io/YOUR_API_KEY
BRIDGE_ADDRESS=0x0000000000000000000000000000000001000006
NETWORK=testnet

# Optional - leave blank to disable alerts
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
DISCORD_WEBHOOK_URL=
```

The `NETWORK` value must be exactly `"mainnet"` or `"testnet"` — the monitor validates this at startup and exits immediately on a typo.

---

## Section 2: Understanding the Bridge ABI

### 2.1 The Bridge Precompile

The critical thing to understand before building a monitor: **the Bridge does not trust external sources for Bitcoin block heights.** It maintains its own **SPV (Simplified Payment Verification)** chain of Bitcoin headers — a full record of every Bitcoin block header, synced by Rootstock nodes themselves.

When you call `getBtcBlockchainBestChainHeight()`, you get the Bridge's own verified BTC chain tip. This is the authoritative number for peg-in confirmation counting. You compare the BTC block your peg-in transaction landed in against this Bridge-internal height — not against Blockstream's API.

Why does this matter? Because the Bridge only unlocks rBTC when _it_ has seen enough Bitcoin confirmations — 100 on mainnet, 10 on testnet. The confirmation count you display must use the Bridge's view:

```
btcConfirmations = bridgeBtcHeight - txBlockHeight + 1
```

The `+1` follows the standard confirmations convention — a transaction has 1 confirmation when the block containing it is the chain tip. The `Math.max(0, ...)` clamp handles the case where the Bridge SPV view briefly lags behind the BTC network right after confirmation.

### 2.2 The Four Functions We Use

The ABI tells ethers.js or web3.py how to encode and decode calls to the Bridge precompile. You only need four read-only functions:

- **`getBtcBlockchainBestChainHeight`** — Bridge's internal SPV view of the Bitcoin chain. Returned as `int32` (signed) to match the Bridge's internal representation; always positive in practice.
- **`getFederationAddress`** — The current PowPeg multisig address on Bitcoin. The federation address changes when the federation composition changes, so the monitor validates your BTC tx targets the _current_ address at startup.
- **`getQueuedPegoutsCount`** — How many peg-out requests are currently waiting in the batch queue.
- **`getNextPegoutCreationBlockNumber`** — The RSK block number when the next batch will be assembled.

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

## Section 3: The Peg-In Monitor (BTC → rBTC)

### 3.1 The Concept: What Happens During a Peg-In?

1. Call `getFederationAddress()` to get the current federation address — **always fetch this fresh**, never hardcode it.
2. Send BTC to that address from a legacy (non-SegWit) Bitcoin wallet — minimum 0.005 BTC.
3. The Bridge watches Bitcoin in SPV mode. Rootstock nodes continuously relay Bitcoin block headers.
4. After the required number of Bitcoin confirmations — **100 on mainnet (~17 hours), 10 on testnet (~100 min)** — the Bridge verifies the payment and mints equivalent rBTC to your Rootstock address.

### 3.2 Validating the Transaction

Before entering the polling loop, the monitor validates that your BTC transaction actually targets the current federation address. This catches two real failure modes:

- You sent BTC to an **outdated federation address** (the PowPeg composition changes periodically — check [powpeg.rootstock.io](https://powpeg.rootstock.io) for the current address).
- You passed the **wrong tx hash** — a 404 from Blockstream is a `FatalError` (no retry), not a transient issue.

```javascript
async function validatePeginTarget(btcTxHash, expectedFedAddress) {
  const res = await withRetry(async () => {
    const r = await fetch(`${BTC_API}/tx/${btcTxHash}`);
    if (r.status === 404) {
      throw new FatalError(
        `Tx ${btcTxHash} not found on ${NETWORK}. Check the hash.`,
      );
    }
    if (!r.ok) throw new Error(`Blockstream HTTP ${r.status}`);
    return r;
  });

  const tx = await res.json();
  // Check .length, not just truthiness — an empty vout array passes !tx?.vout
  // but would produce a misleading "does not target federation" error.
  if (!tx?.vout?.length) {
    throw new Error(`Could not fetch outputs for tx ${btcTxHash}.`);
  }
  const targeted = tx.vout.some(
    (v) => v.scriptpubkey_address === expectedFedAddress,
  );
  if (!targeted) {
    throw new Error(
      `Tx ${btcTxHash} does not send to federation address ${expectedFedAddress}.\n` +
        `The PowPeg composition may have changed. Check powpeg.rootstock.io.`,
    );
  }
}
```

### 3.3 The Poll Loop

Once validated, the monitor polls every 60 seconds — Bitcoin blocks arrive every ~10 minutes so there's no benefit to polling faster, and a 60s interval stays comfortably within the free RPC tier (25,000 req/day).

```javascript
async function monitorPegin(btcTxHash, rskAddress) {
  if (btcTxHash.startsWith("0x") || btcTxHash.startsWith("0X")) {
    btcTxHash = btcTxHash.slice(2);
    console.warn(`  Warning: stripped 0x prefix from BTC tx hash.`);
  }

  const state = loadState();
  let alertedComplete = state[`${btcTxHash}_complete`] || false;

  const fedAddress = await withRetry(() => bridge.getFederationAddress());
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
          "BTC Tx Hash": `${btcTxHash.slice(0, 20)}...`,
          "RSK Address": `${rskAddress.slice(0, 20)}...`,
          "Bridge BTC Height": String(bridgeBtcHeight),
          "BTC Status": "Unconfirmed (mempool)",
          Confirmations: `0 / ${PEGIN_REQUIRED}`,
          ETA: secondsToHuman(PEGIN_REQUIRED * BTC_BLOCK_TIME),
        });
        return;
      }

      const txBlockHeight = txData.status.block_height;
      const btcConfirmations = Math.max(
        0,
        Number(bridgeBtcHeight) - txBlockHeight + 1,
      );
      const remaining = Math.max(0, PEGIN_REQUIRED - btcConfirmations);
      const complete = btcConfirmations >= PEGIN_REQUIRED;

      printStatus("PEG-IN (BTC → rBTC)", {
        "BTC Tx Hash": `${btcTxHash.slice(0, 20)}...`,
        "RSK Address": `${rskAddress.slice(0, 20)}...`,
        "BTC Tx Block": String(txBlockHeight),
        "Bridge BTC Height": String(bridgeBtcHeight),
        Confirmations: `${btcConfirmations} / ${PEGIN_REQUIRED}`,
        Status: complete
          ? "COMPLETE — rBTC credited"
          : `Waiting (${btcConfirmations}/${PEGIN_REQUIRED} BTC blocks)`,
        ETA:
          remaining > 0 ? secondsToHuman(remaining * BTC_BLOCK_TIME) : "Done",
      });

      // Single merged write — prevents a crash between two separate writes from
      // leaving _complete unset and causing a duplicate alert on the next restart.
      const updates = { [`${btcTxHash}_confirms`]: btcConfirmations };
      if (complete && !alertedComplete) updates[`${btcTxHash}_complete`] = true;
      saveState({ ...loadState(), ...updates });

      if (complete && !alertedComplete) {
        alertedComplete = true;
        await sendAlert(
          `*PowPeg Peg-In Complete*\nBTC Tx: \`${btcTxHash}\`\nrBTC credited to: \`${rskAddress}\`\nNetwork: ${NETWORK}`,
        );
      }
    } catch (err) {
      if (err instanceof FatalError) {
        console.error(`\n  Fatal: ${err.message}\n`);
        process.exit(1);
      }
      console.error(`  Poll error: ${err.message}`);
    }
  }

  await poll();
  const timer = setInterval(poll, POLL_INTERVAL);

  // process.once (not .on) — prevents handler accumulation if this function
  // is called more than once in the same process (e.g. in tests).
  process.once("SIGINT", () => {
    clearInterval(timer);
    console.log("\n  Monitor stopped.\n");
    process.exit(0);
  });
}
```

---

## Section 4: The Peg-Out Monitor (rBTC → BTC)

### 4.1 The Concept: What Happens During a Peg-Out?

1. Send rBTC directly to the Bridge contract address on Rootstock — minimum 0.004 rBTC, gas limit 100,000.
2. The Bridge **queues** your request. Peg-outs are batched every ~360 RSK blocks (~3 hours).
3. After the required RSK confirmations — **4,000 on mainnet (~34 hours), 10 on testnet (~5 min)** — the PowHSM devices sign the Bitcoin transaction with their hardware-secured keys and broadcast it to the Bitcoin network.

The 4,000 RSK block threshold on mainnet exists because a deep Rootstock chain reorganization could theoretically undo a peg-out request. Waiting 4,000 blocks makes such a reorg computationally infeasible in practice.

For peg-out monitoring, everything is on RSK — no Bitcoin API calls needed.

### 4.2 Tracking RSK Confirmations

```javascript
async function monitorPegout(rskTxHash) {
  const state = loadState();
  let alertedQueued = state[`${rskTxHash}_queued`] || false;
  let alertedComplete = state[`${rskTxHash}_complete`] || false;

  async function poll() {
    try {
      const [currentBlock, receipt] = await Promise.all([
        withRetry(() => provider.getBlockNumber()),
        withRetry(() => provider.getTransactionReceipt(rskTxHash)),
      ]);

      if (!receipt) {
        printStatus("PEG-OUT (rBTC → BTC)", {
          "RSK Tx Hash": `${rskTxHash.slice(0, 22)}...`,
          "Current Block": String(currentBlock),
          Status: "Pending — not yet mined",
          Confirmations: `0 / ${PEGOUT_REQUIRED}`,
        });
        return;
      }

      const txBlock = receipt.blockNumber;
      const rskConfirms = currentBlock - txBlock;
      const remaining = Math.max(0, PEGOUT_REQUIRED - rskConfirms);
      const complete = rskConfirms >= PEGOUT_REQUIRED;

      const [queuedCount, nextBatchBlock] = await Promise.all([
        withRetry(() => bridge.getQueuedPegoutsCount()),
        withRetry(() => bridge.getNextPegoutCreationBlockNumber()),
      ]);

      const blocksToNext = Math.max(0, Number(nextBatchBlock) - currentBlock);

      // 10 RSK confirms (~5 min) is a useful display milestone — the tx is safely
      // included. It's not a protocol threshold, just an early status indicator.
      const status = complete
        ? "COMPLETE — BTC broadcast"
        : rskConfirms >= 10
          ? `Processing (${rskConfirms}/${PEGOUT_REQUIRED} RSK blocks)`
          : "Queued — awaiting minimum confirmations";

      printStatus("PEG-OUT (rBTC → BTC)", {
        "RSK Tx Hash": `${rskTxHash.slice(0, 22)}...`,
        "Tx Block": String(txBlock),
        "Current Block": String(currentBlock),
        Confirmations: `${rskConfirms} / ${PEGOUT_REQUIRED}`,
        "Queue Size": `${queuedCount} pending pegout(s)`,
        "Next Batch": blocksToNext > 0 ? `${blocksToNext} blocks` : "Imminent",
        Status: status,
        ETA:
          remaining > 0 ? secondsToHuman(remaining * RSK_BLOCK_TIME) : "Done",
      });

      const updates = { [`${rskTxHash}_confirms`]: rskConfirms };
      if (rskConfirms >= 10 && !alertedQueued)
        updates[`${rskTxHash}_queued`] = true;
      if (complete && !alertedComplete) updates[`${rskTxHash}_complete`] = true;
      saveState({ ...loadState(), ...updates });

      if (rskConfirms >= 10 && !alertedQueued) {
        alertedQueued = true;
        await sendAlert(
          `*PowPeg Peg-Out Queued*\nRSK Tx: \`${rskTxHash}\`\n${rskConfirms} RSK confirmations so far.\nNetwork: ${NETWORK}`,
        );
      }

      if (complete && !alertedComplete) {
        alertedComplete = true;
        await sendAlert(
          `*PowPeg Peg-Out Complete*\nRSK Tx: \`${rskTxHash}\`\n${PEGOUT_REQUIRED} RSK confirmations reached. BTC broadcast.\nNetwork: ${NETWORK}`,
        );
      }
    } catch (err) {
      if (err instanceof FatalError) {
        console.error(`\n  Fatal: ${err.message}\n`);
        process.exit(1);
      }
      console.error(`  Poll error: ${err.message}`);
    }
  }

  await poll();
  const timer = setInterval(poll, POLL_INTERVAL);

  process.once("SIGINT", () => {
    clearInterval(timer);
    console.log("\n  Monitor stopped.\n");
    process.exit(0);
  });
}
```

---

## Section 5: Alerts — Telegram and Discord

### 5.1 Telegram Setup

1. Open Telegram and message `@BotFather` — send `/newbot` and follow the prompts to get a **bot token**.
2. Start a chat with your bot, then visit `https://api.telegram.org/bot<YOUR_TOKEN>/getUpdates` to find your **chat ID**.
3. Add both to `.env`:

```env
TELEGRAM_BOT_TOKEN=1234567890:ABCdef...
TELEGRAM_CHAT_ID=987654321
```

### 5.2 Discord Setup

1. In your Discord server, go to **Server Settings → Integrations → Webhooks → New Webhook**.
2. Copy the webhook URL and add it to `.env`:

```env
DISCORD_WEBHOOK_URL=https://discord.com/api/webhooks/...
```

The `sendAlert` function dispatches both notifications concurrently — `Promise.all` in JS, `ThreadPoolExecutor` in Python — so a slow alert endpoint doesn't block the poll loop.

```javascript
async function sendAlert(message) {
  console.log(`\n  [ALERT] ${message}\n`);
  await Promise.all([sendTelegram(message), sendDiscord(message)]);
}
```

If either env variable is missing or set to a placeholder, that channel is silently skipped. Leave both blank to run the monitor in display-only mode.

---

## Section 6: The Python Version

The Python version is functionally identical — same confirmation math, same retry behavior, same output format. Create `monitor.py`:

```python
"""
PowPeg bridge monitor — Python version.
Tracks peg-in (BTC → rBTC) and peg-out (rBTC → BTC) confirmation progress.
"""

import json
import os
import re
import sys
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime
from pathlib import Path

import requests
from dotenv import load_dotenv
from web3 import Web3

load_dotenv()

class FatalError(Exception):
    pass

RSK_RPC_URL    = os.getenv("RSK_RPC_URL")
BRIDGE_ADDRESS = os.getenv("BRIDGE_ADDRESS", "0x0000000000000000000000000000000001000006")
NETWORK        = os.getenv("NETWORK", "testnet")
POLL_INTERVAL  = 60
_HERE          = Path(__file__).parent
STATE_FILE     = str(_HERE / "monitor-state.json")

if not RSK_RPC_URL:
    print("RSK_RPC_URL is not set in .env")
    sys.exit(1)

if NETWORK not in ("mainnet", "testnet"):
    print(f'Error: NETWORK="{NETWORK}" is invalid — must be "mainnet" or "testnet" in .env')
    sys.exit(1)

PEGIN_REQUIRED  = 100 if NETWORK == "mainnet" else 10
PEGOUT_REQUIRED = 4000 if NETWORK == "mainnet" else 10
BTC_BLOCK_TIME  = 600
RSK_BLOCK_TIME  = 30

BTC_API = (
    "https://blockstream.info/api"
    if NETWORK == "mainnet"
    else "https://blockstream.info/testnet/api"
)

w3 = Web3(Web3.HTTPProvider(RSK_RPC_URL))

try:
    with open(_HERE / "bridge-abi.json") as f:
        BRIDGE_ABI = json.load(f)
except FileNotFoundError:
    print("Error: bridge-abi.json not found. Run: git checkout bridge-abi.json")
    sys.exit(1)

bridge = w3.eth.contract(
    address=Web3.to_checksum_address(BRIDGE_ADDRESS),
    abi=BRIDGE_ABI,
)

def load_state() -> dict:
    try:
        if os.path.exists(STATE_FILE):
            with open(STATE_FILE) as f:
                return json.load(f)
    except Exception as e:
        print(f"  Warning: could not read state file, starting fresh. ({e})")
    return {}

def save_state(state: dict) -> None:
    # Write to a temp file then replace — atomic on POSIX, prevents a kill signal
    # mid-write from leaving a truncated/corrupt state file.
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(state, f, indent=2)
    os.replace(tmp, STATE_FILE)

def seconds_to_human(seconds: int) -> str:
    if seconds < 60:
        return f"{seconds}s"
    if seconds < 3600:
        return f"{round(seconds / 60)}m"
    h = seconds // 3600
    m = round((seconds % 3600) / 60)
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
    # Fire Telegram and Discord concurrently — each has a 10s timeout so
    # running them sequentially would block the poll loop for up to 20s.
    with ThreadPoolExecutor(max_workers=2) as executor:
        executor.submit(send_telegram, message)
        executor.submit(send_discord, message)

def with_retry(fn, max_retries: int = 3):
    for i in range(max_retries):
        try:
            return fn()
        except FatalError:
            raise
        except Exception as e:
            if i == max_retries - 1:
                raise
            delay = 2 ** (i + 1)
            print(f"  [attempt {i + 1}/{max_retries} failed] {e} — retrying in {delay}s")
            time.sleep(delay)

def validate_pegin_target(btc_tx_hash: str, expected_fed_address: str) -> None:
    def fetch_tx():
        r = requests.get(f"{BTC_API}/tx/{btc_tx_hash}", timeout=10)
        if r.status_code == 404:
            raise FatalError(f"Tx {btc_tx_hash} not found on {NETWORK}. Check the hash.")
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
            f"The PowPeg composition may have changed. Check powpeg.rootstock.io."
        )

def monitor_pegin(btc_tx_hash: str, rsk_address: str) -> None:
    if btc_tx_hash.startswith(("0x", "0X")):
        btc_tx_hash = btc_tx_hash[2:]
        print("  Warning: stripped 0x prefix from BTC tx hash.")

    state            = load_state()
    alerted_complete = state.get(f"{btc_tx_hash}_complete", False)

    fed_address = with_retry(lambda: bridge.functions.getFederationAddress().call())
    validate_pegin_target(btc_tx_hash, fed_address)

    def fetch_btc_tx():
        r = requests.get(f"{BTC_API}/tx/{btc_tx_hash}", timeout=10)
        if r.status_code != 200:
            raise RuntimeError(f"Blockstream HTTP {r.status_code}")
        return r.json()

    while True:
        try:
            bridge_btc_height = with_retry(
                lambda: bridge.functions.getBtcBlockchainBestChainHeight().call()
            )
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
                confirms  = max(0, bridge_btc_height - tx_block + 1)
                remaining = max(0, PEGIN_REQUIRED - confirms)
                complete  = confirms >= PEGIN_REQUIRED

                print_status("PEG-IN (BTC → rBTC)", {
                    "BTC Tx Hash"      : f"{btc_tx_hash[:20]}...",
                    "RSK Address"      : f"{rsk_address[:20]}...",
                    "BTC Tx Block"     : str(tx_block),
                    "Bridge BTC Height": str(bridge_btc_height),
                    "Confirmations"    : f"{confirms} / {PEGIN_REQUIRED}",
                    "Status"           : "COMPLETE — rBTC credited" if complete
                                         else f"Waiting ({confirms}/{PEGIN_REQUIRED} BTC blocks)",
                    "ETA"              : seconds_to_human(remaining * BTC_BLOCK_TIME) if remaining > 0 else "Done",
                })

                updates = {f"{btc_tx_hash}_confirms": confirms}
                if complete and not alerted_complete:
                    updates[f"{btc_tx_hash}_complete"] = True
                current = load_state()
                current.update(updates)
                save_state(current)

                if complete and not alerted_complete:
                    alerted_complete = True
                    send_alert(
                        f"✅ *PowPeg Peg-In Complete*\n"
                        f"BTC Tx: `{btc_tx_hash}`\n"
                        f"rBTC credited to: `{rsk_address}`\n"
                        f"Network: {NETWORK}"
                    )

        except FatalError as e:
            print(f"\n  Fatal: {e}\n")
            sys.exit(1)
        except Exception as e:
            print(f"  Poll error: {e}")

        time.sleep(POLL_INTERVAL)

def monitor_pegout(rsk_tx_hash: str) -> None:
    state            = load_state()
    alerted_queued   = state.get(f"{rsk_tx_hash}_queued",   False)
    alerted_complete = state.get(f"{rsk_tx_hash}_complete", False)

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
                    "COMPLETE — BTC broadcast"
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

                updates = {f"{rsk_tx_hash}_confirms": confirms}
                if confirms >= 10 and not alerted_queued:
                    updates[f"{rsk_tx_hash}_queued"] = True
                if complete and not alerted_complete:
                    updates[f"{rsk_tx_hash}_complete"] = True
                current = load_state()
                current.update(updates)
                save_state(current)

                if confirms >= 10 and not alerted_queued:
                    alerted_queued = True
                    send_alert(
                        f"🔄 *PowPeg Peg-Out Queued*\n"
                        f"RSK Tx: `{rsk_tx_hash}`\n"
                        f"{confirms} RSK confirmations so far.\n"
                        f"Network: {NETWORK}"
                    )

                if complete and not alerted_complete:
                    alerted_complete = True
                    send_alert(
                        f"✅ *PowPeg Peg-Out Complete*\n"
                        f"RSK Tx: `{rsk_tx_hash}`\n"
                        f"{PEGOUT_REQUIRED} RSK confirmations reached. BTC broadcast.\n"
                        f"Network: {NETWORK}"
                    )

        except FatalError as e:
            print(f"\n  Fatal: {e}\n")
            sys.exit(1)
        except Exception as e:
            print(f"  Poll error: {e}")

        time.sleep(POLL_INTERVAL)

BTC_HASH_RE = re.compile(r"^[0-9a-fA-F]{64}$")
RSK_HASH_RE = re.compile(r"^0x[0-9a-fA-F]{64}$", re.IGNORECASE)

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: python monitor.py [pegin|pegout] <txHash> [rskAddress]")
        sys.exit(1)

    mode = sys.argv[1]

    if mode == "pegin":
        if len(sys.argv) < 4:
            print("Usage: python monitor.py pegin <btcTxHash> <rskAddress>")
            sys.exit(1)
        raw_hash = sys.argv[2]
        clean_hash = raw_hash[2:] if raw_hash.lower().startswith("0x") else raw_hash
        if not BTC_HASH_RE.match(clean_hash):
            print("Error: BTC tx hash must be exactly 64 hex characters.")
            sys.exit(1)
        monitor_pegin(raw_hash, sys.argv[3])
    elif mode == "pegout":
        raw_hash = sys.argv[2]
        if not RSK_HASH_RE.match(raw_hash):
            print("Error: RSK tx hash must be 0x followed by 64 hex characters.")
            sys.exit(1)
        monitor_pegout(raw_hash)
    else:
        print("Mode must be 'pegin' or 'pegout'")
        sys.exit(1)
```

Four differences from the JS version worth noting:

- **Synchronous I/O** — A blocking `while True` / `time.sleep(60)` loop instead of `setInterval`. Simpler to reason about for a single-transaction monitor.
- **Concurrent alerts** — `requests` is synchronous, so `send_telegram` + `send_discord` run in a `ThreadPoolExecutor(max_workers=2)` — matching the JS `Promise.all` behavior. Without this, both calls block sequentially for up to 20 seconds.
- **FatalError in the poll loop** — Explicitly caught before `except Exception` so it calls `sys.exit(1)` instead of being swallowed and looping forever.
- **Checksum addresses** — `web3.py` requires `Web3.to_checksum_address()` for contract calls. ethers.js handles this transparently.

---

## Section 7: Running the Monitor

### 7.1 CLI Reference

```bash
# Peg-in: track a BTC transaction being pegged into Rootstock
node monitor.js pegin <btcTxHash> <rskAddress>

# Peg-out: track an RSK transaction being pegged out to Bitcoin
node monitor.js pegout <rskTxHash>

# Python equivalents
python monitor.py pegin <btcTxHash> <rskAddress>
python monitor.py pegout <rskTxHash>
```

The dashboard refreshes every 60 seconds (one poll cycle). It is not live-streaming — the update interval reflects BTC block times (~10 min) and the free RPC tier limits.

### 7.2 Testnet Walkthrough

The fastest way to try the monitor end-to-end is with a testnet peg-out, which only requires 10 RSK confirmations (~5 minutes).

**Step 1 — Find a testnet peg-out transaction**

Go to the [Rootstock testnet explorer](https://explorer.testnet.rootstock.io/address/0x0000000000000000000000000000000001000006) and look for a recent incoming transaction to the Bridge contract address. Copy the transaction hash.

Alternatively, use this representative example transaction hash from testnet:

```
0x6bf61dd27a57e6f70178a6385a4acf14a181e8daa737f4c2e1124e7a2ee75cbf
```

> **Note:** This is transaction hash from th e testnet explorer, you can replace it with a a different transaction hash from the testnet explorer before running.

**Step 2 — Set up your `.env`**

```env
RSK_RPC_URL=https://rpc.testnet.rootstock.io/YOUR_API_KEY
NETWORK=testnet
```

**Step 3 — Run the monitor**

JavaScript:

```bash
node monitor.js pegout 0x<your-testnet-tx-hash>
```

Python:

```bash
python monitor.py pegout 0x<your-testnet-tx-hash>
```

**Expected output:**

```
╔════════════════════════════════════════════╗
║  PowPeg Monitor — TESTNET                  ║
╚════════════════════════════════════════════╝

  Type              : PEG-OUT (rBTC → BTC)
  RSK Tx Hash       : 0x3fa2c1b8e9d04a7f...
  Tx Block          : 6142301
  Current Block     : 6142320
  Confirmations     : 19 / 10
  Queue Size        : 2 pending pegout(s)
  Next Batch        : Imminent
  Status            : ✓ COMPLETE — BTC broadcast
  ETA               : Done

  Updated           : 14:32:07
  Press Ctrl+C to stop.
```

On testnet, a fresh peg-out transaction reaches 10 RSK confirmations in about 5 minutes. For a peg-in walkthrough, find a testnet BTC transaction at [Blockstream testnet explorer](https://blockstream.info/testnet) sent to the testnet federation address (fetched via `getFederationAddress()` on testnet).

Press `Ctrl+C` to stop cleanly. The monitor saves confirmation progress to `monitor-state.json` on every poll cycle so it can resume seamlessly after a restart.

---

## Section 8: Design Decisions Worth Knowing

A few choices in the monitor that go beyond "make it work":

- **`FatalError` vs retryable errors** — A Blockstream 404 means your BTC tx hash is wrong. Retrying will never fix it. Classifying it as `FatalError` stops the monitor immediately with a clear message instead of silently looping for hours.

- **Atomic state writes** — State is written to a `.tmp` file first, then renamed over the target. A kill signal mid-write leaves the `.tmp` file, not a truncated JSON. Corrupt state on restart means alert deduplication is lost — you'd get duplicate "complete" notifications.

- **Single merged state write per cycle** — Both `_confirms` and `_complete` keys are written in the same `saveState` call. A crash between two separate writes would leave `_complete` unset, causing the completion alert to fire again on the next restart.

- **NETWORK validation at startup** — `NETWORK=Mainnet` (capital M) would silently use testnet thresholds and the testnet Blockstream API. The monitor validates against `["mainnet", "testnet"]` and exits immediately on a mismatch.

- **Input validation before polling** — BTC tx hashes must be exactly 64 hex characters; RSK tx hashes must match `0x[0-9a-fA-F]{64}`. A typo caught at startup saves you from 30 minutes of confusing RPC errors.

- **`process.once` for SIGINT** — Using `process.on` would stack handlers if `monitorPegin`/`monitorPegout` were ever called more than once in the same process (e.g. in tests), causing duplicate exits and Node `MaxListenersExceeded` warnings.

- **`require.main === module` guard** — The entry point is wrapped so test suites can import and unit-test individual functions without triggering the CLI. All internals are exported via `module.exports`.

---

## Section 9: Reproducing Testnet Monitoring

To verify the monitor works exactly as expected, run these commands and compare your output to the examples below. These use real, already-confirmed testnet transactions.

**JavaScript (Peg-In):**

```bash
node monitor.js pegin \
  a74918ced40b93d8cf9843cc952db41d233fda569ae60cee240292153a529526 \
  0x742d35Cc6634C0553241234561234561234567890
```

**Python (Peg-Out):**

```bash
python3 monitor.py pegout \
  0x7695bb4c1dbaf9840d3cafb3fa539162f5f116e7d74cf25bad604a9dd4669d19
```

Both transactions should show `Status: COMPLETE` because they were confirmed long ago. The monitor validates Bridge contract calls, Blockstream API, and confirmation math.

---

## Wrapping Up

Great work! You've now built a production-grade PowPeg monitor — in both JavaScript and Python — that tracks BTC↔rBTC transfer progress via near real-time polling, fires Telegram and Discord alerts on completion, and handles the failure modes that a bridge monitor actually encounters in the wild.

I hope this tutorial gives you a solid understanding of how the Rootstock PowPeg works under the hood and how to build reliable tooling on top of it. The full source, test suite, and `.env.example` are all at **[github.com/michojekunle/powpeg-monitor](https://github.com/michojekunle/powpeg-monitor)** — star the repo if this was useful, and feel free to open an issue or PR.

Keep building on Rootstock.

---

**Rootstock community resources:**

- [Rootstock Discord](https://discord.gg/rootstock)
- [Rootstock Telegram](https://t.me/rootstock_official)
- [Rootstock Docs](https://dev.rootstock.io)
- [PowPeg Portal](https://powpeg.rootstock.io)
