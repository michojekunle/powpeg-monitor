# PowPeg Monitor

Real-time confirmation tracker for the Rootstock PowPeg bridge. Monitors peg-in (BTC → rBTC) and peg-out (rBTC → BTC) transactions, counts confirmations, estimates time remaining, and fires Telegram or Discord alerts when funds land.

No backend server required. Runs from a single script in JavaScript or Python.

---

## What it tracks

| Direction | Confirmations required | Mainnet estimate | Testnet estimate |
|-----------|----------------------|-----------------|-----------------|
| Peg-in (BTC → rBTC) | 100 BTC blocks | ~17 hours | ~100 min |
| Peg-out (rBTC → BTC) | 4,000 RSK blocks | ~34 hours | ~5 min |

---

## Prerequisites

- Node.js v18+ (JavaScript) or Python 3.10+ (Python)
- Rootstock RPC endpoint — free at [dashboard.rpc.rootstock.io](https://dashboard.rpc.rootstock.io) or via [Alchemy](https://alchemy.com)
- A peg-in BTC tx hash or peg-out RSK tx hash to monitor

---

## Setup

```bash
git clone https://github.com/michojekunle/powpeg-monitor.git
cd powpeg-monitor
cp .env.example .env
# Edit .env with your RPC URL
```

**JavaScript:**
```bash
npm install
```

**Python:**
```bash
# Install into the same Python you will run the script with.
# IMPORTANT: use "python3.x -m pip" not a bare "pip3" — on macOS the two
# can point to different interpreters, causing "module not found" errors.
python3 -m pip install web3 python-dotenv requests
```

> **Python version note:** Python 3.10–3.13 recommended. If you're on macOS with Homebrew Python 3.14 and see a `pyexpat` / `libexpat` error during install, install a supported version first:
> ```bash
> brew install python@3.12
> python3.12 -m pip install web3 python-dotenv requests
> python3.12 monitor.py pegin ...
> ```
> `./test.sh` detects and uses a working Python automatically.

---

## Environment variables

```env
RSK_RPC_URL=https://rpc.testnet.rootstock.io/YOUR_API_KEY
BRIDGE_ADDRESS=0x0000000000000000000000000000000001000006
NETWORK=testnet   # or mainnet

# Optional — leave blank to disable
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
DISCORD_WEBHOOK_URL=
```

---

## Usage

### JavaScript

```bash
# Monitor a peg-in (BTC → rBTC)
node monitor.js pegin <btcTxHash> <yourRskAddress>

# Monitor a peg-out (rBTC → BTC)
node monitor.js pegout <rskTxHash>
```

### Python

```bash
# Monitor a peg-in
python3 monitor.py pegin <btcTxHash> <yourRskAddress>

# Monitor a peg-out
python3 monitor.py pegout <rskTxHash>
```

### Test with real transactions (no wallet needed)

These confirmed testnet transactions let you verify the monitor immediately — no BTC or rBTC required.

| Field | Value |
|-------|-------|
| BTC peg-in tx | `a74918ced40b93d8cf9843cc952db41d233fda569ae60cee240292153a529526` |
| BTC testnet block | 4,918,812 |
| RSK peg-out tx | `0x7695bb4c1dbaf9840d3cafb3fa539162f5f116e7d74cf25bad604a9dd4669d19` |
| RSK testnet block | 7,562,606 |
| RSK address (placeholder — use your own to receive rBTC) | `0x742d35Cc6634C0553241234561234561234567890` |

**JavaScript:**
```bash
# Peg-in (BTC → rBTC)
node monitor.js pegin \
  a74918ced40b93d8cf9843cc952db41d233fda569ae60cee240292153a529526 \
  0x742d35Cc6634C0553241234561234561234567890

# Peg-out (rBTC → BTC)
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

Both transactions show `Status: ✓ COMPLETE` — they were confirmed long ago. The monitor validates Bridge contract calls, Blockstream API, and confirmation math. To see a live countdown, send your own testnet transaction.

---

## Sample output

```
╔════════════════════════════════════════════╗
║  PowPeg Monitor — TESTNET                 ║
╚════════════════════════════════════════════╝

  Type              : PEG-IN (BTC → rBTC)
  BTC Tx Hash       : a3f9c1e847b2d061f5...
  RSK Address       : 0x742d35Cc6634C05532...
  BTC Tx Block      : 3168720
  Bridge BTC Height : 3168724
  Confirmations     : 4 / 10
  Status            : Waiting (4/10 BTC blocks)
  ETA               : 1h

  Updated           : 14:23:07
  Press Ctrl+C to stop.
```

---

## How it works

**Peg-in monitoring** queries the Bridge contract for its live SPV view of the Bitcoin chain (`getBtcBlockchainBestChainHeight`), then fetches the BTC transaction's block height from the Blockstream API. The difference is your confirmation count.

**Peg-out monitoring** reads the RSK transaction receipt's block number, then computes `currentBlock - txBlock`. It also polls `getQueuedPegoutsCount` and `getNextPegoutCreationBlockNumber` from the Bridge to show queue state.

State is persisted to `monitor-state.json` so the monitor resumes from the correct alert state after a restart.

---

## Running the test suite

A single script verifies everything end-to-end — dependencies, Bridge contract calls, Blockstream API, state persistence, retry logic, live monitor output, and alert endpoints:

```bash
chmod +x test.sh   # first time only
./test.sh
```

The script auto-detects a working Python 3.10–3.13 and installs packages into **that exact interpreter** (using `$PYTHON -m pip`), avoiding the macOS pip-mismatch issue that was breaking installs.

Options:
```bash
./test.sh --js-only    # JavaScript tests only
./test.sh --py-only    # Python tests only
./test.sh --smoke      # Live monitor smoke tests only (peg-in + peg-out output)
./test.sh --alerts     # Alert endpoint tests only (Telegram + Discord)
./test.sh --no-smoke   # Skip the live monitor smoke tests
./test.sh --no-alerts  # Skip alert endpoint tests
```

Or run the language-specific suites directly:
```bash
node test.js       # JS: utilities, state, retry, Bridge, Blockstream, alerts
python3 test.py    # Python: equivalent coverage
```

All tests use real confirmed testnet transactions as fixtures and hit the live Bridge contract, so a valid `RSK_RPC_URL` in `.env` is required.

---

## Alert setup

### Telegram
1. Open Telegram → search `@BotFather` → `/newbot` → copy the bot token
2. Start a chat with your bot, then visit `https://api.telegram.org/bot<TOKEN>/getUpdates`
3. Send your bot a message, find `"chat": {"id": ...}` in the JSON — that's your chat ID
4. Add both to `.env`

### Discord
1. Server Settings → Integrations → Webhooks → New Webhook → copy the URL
2. Add `DISCORD_WEBHOOK_URL` to `.env`

---

## Bridge contract reference

- **Address (mainnet + testnet):** `0x0000000000000000000000000000000001000006`
- **Minimum peg-in:** 0.005 BTC
- **Minimum peg-out:** 0.004 rBTC (gas limit: 100,000, gas price: 0.06 gwei)
- **Peg-out batch window:** ~360 RSK blocks (~3 hours)

Always verify the current federation address by calling `getFederationAddress()` on the Bridge before sending BTC. The PowPeg composition changes periodically.

---

## License

MIT
