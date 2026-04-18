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
