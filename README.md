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
pip install web3 python-dotenv requests
```

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
python monitor.py pegin <btcTxHash> <yourRskAddress>

# Monitor a peg-out
python monitor.py pegout <rskTxHash>
```

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
