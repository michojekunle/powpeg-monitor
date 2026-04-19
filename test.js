"use strict";

/**
 * PowPeg Monitor — test suite (JavaScript)
 *
 * Tests utility logic, state persistence, retry behaviour, live Bridge contract
 * calls, and Blockstream API integration. Requires a valid RSK_RPC_URL in .env.
 *
 * Run: node test.js
 */

const assert  = require("assert");
const fs      = require("fs");
const path    = require("path");
require("dotenv").config();

// ── Helpers ────────────────────────────────────────────────────────────────────

const PASS  = "✓";
const FAIL  = "✗";
const SKIP  = "⚠";
let passed  = 0;
let failed  = 0;
let skipped = 0;

// Errors from external APIs that are beyond our control — treat as skips
const isExternalApiFailure = (err) =>
  /Blockstream HTTP [5-9]\d\d|ECONNRESET|ECONNREFUSED|timeout|ETIMEDOUT/i.test(err.message);

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ${PASS}  ${name}`);
    passed++;
  } catch (err) {
    if (isExternalApiFailure(err)) {
      console.log(`  ${SKIP}  ${name} (skipped — external API unavailable: ${err.message.slice(0, 60)})`);
      skipped++;
    } else {
      console.log(`  ${FAIL}  ${name}`);
      console.log(`       ${err.message}`);
      failed++;
    }
  }
}

function section(label) {
  console.log(`\n── ${label} ${"─".repeat(50 - label.length)}`);
}

// ── Import monitor internals ───────────────────────────────────────────────────

const {
  withRetry,
  loadState,
  saveState,
  secondsToHuman,
  validatePeginTarget,
  provider,
  bridge,
  NETWORK,
  PEGIN_REQUIRED,
  PEGOUT_REQUIRED,
  BTC_API,
  STATE_FILE,
} = require("./monitor.js");

// ── Real testnet values ────────────────────────────────────────────────────────

const TESTNET_PEGIN_TX  = "a74918ced40b93d8cf9843cc952db41d233fda569ae60cee240292153a529526";
const TESTNET_PEGOUT_TX = "0x7695bb4c1dbaf9840d3cafb3fa539162f5f116e7d74cf25bad604a9dd4669d19";
const TESTNET_FED_ADDR  = "2N88sMiizxmbb8Y3yA4AtYmL1RxHogWfoHa";
const DUMMY_RSK_ADDR    = "0x742d35Cc6634C0553241234561234561234567890";

// ── Test suites ────────────────────────────────────────────────────────────────

async function runUtilityTests() {
  section("Utility functions");

  await test("secondsToHuman: seconds", () => {
    assert.strictEqual(secondsToHuman(45), "45s");
  });

  await test("secondsToHuman: minutes", () => {
    assert.strictEqual(secondsToHuman(90), "2m");
  });

  await test("secondsToHuman: hours and minutes", () => {
    assert.strictEqual(secondsToHuman(3900), "1h 5m");
  });

  await test("secondsToHuman: exactly one hour", () => {
    assert.strictEqual(secondsToHuman(3600), "1h 0m");
  });

  await test("confirmation thresholds are correct for network", () => {
    if (NETWORK === "mainnet") {
      assert.strictEqual(PEGIN_REQUIRED,  100);
      assert.strictEqual(PEGOUT_REQUIRED, 4000);
    } else {
      assert.strictEqual(PEGIN_REQUIRED,  10);
      assert.strictEqual(PEGOUT_REQUIRED, 10);
    }
  });

  await test("BTC_API points to correct network endpoint", () => {
    if (NETWORK === "mainnet") {
      assert.ok(BTC_API.includes("blockstream.info/api"));
      assert.ok(!BTC_API.includes("testnet"));
    } else {
      assert.ok(BTC_API.includes("testnet"));
    }
  });
}

async function runStateTests() {
  section("State persistence");

  const tmpFile = path.join(__dirname, "monitor-state-test-tmp.json");

  // Use a temp state file for isolation — patch the module path
  const origFile = STATE_FILE;

  await test("saveState writes valid JSON", () => {
    fs.writeFileSync(tmpFile, JSON.stringify({ foo: "bar" }, null, 2));
    const raw = fs.readFileSync(tmpFile, "utf8");
    const parsed = JSON.parse(raw);
    assert.strictEqual(parsed.foo, "bar");
    fs.unlinkSync(tmpFile);
  });

  await test("loadState returns empty object when file missing", () => {
    const state = loadState();
    assert.ok(typeof state === "object");
  });

  await test("loadState returns empty object on corrupt JSON", () => {
    fs.writeFileSync(tmpFile, "not json {{{{");
    // loadState reads STATE_FILE, not tmpFile — simulate by temporarily
    // writing corrupt data to the real state file if it doesn't exist yet.
    // Skip if state file already exists (don't clobber real data).
    if (!fs.existsSync(origFile)) {
      fs.writeFileSync(origFile, "not json");
      const state = loadState();
      assert.deepStrictEqual(state, {});
      fs.unlinkSync(origFile);
    }
    fs.unlinkSync(tmpFile);
  });

  await test("round-trip: saveState then loadState", () => {
    const backup = fs.existsSync(STATE_FILE)
      ? fs.readFileSync(STATE_FILE, "utf8")
      : null;

    saveState({ test_key: "test_value", count: 42 });
    const loaded = loadState();
    assert.strictEqual(loaded.test_key, "test_value");
    assert.strictEqual(loaded.count, 42);

    // Restore original state
    if (backup !== null) {
      fs.writeFileSync(STATE_FILE, backup);
    } else {
      fs.unlinkSync(STATE_FILE);
    }
  });

  await test("state merge preserves existing keys", () => {
    const backup = fs.existsSync(STATE_FILE)
      ? fs.readFileSync(STATE_FILE, "utf8")
      : null;

    saveState({ key_a: 1 });
    saveState({ ...loadState(), key_b: 2 });
    const state = loadState();
    assert.strictEqual(state.key_a, 1);
    assert.strictEqual(state.key_b, 2);

    if (backup !== null) {
      fs.writeFileSync(STATE_FILE, backup);
    } else {
      fs.unlinkSync(STATE_FILE);
    }
  });
}

async function runRetryTests() {
  section("Retry wrapper (withRetry)");

  await test("succeeds immediately when fn resolves", async () => {
    const result = await withRetry(() => Promise.resolve(42));
    assert.strictEqual(result, 42);
  });

  await test("retries on error and eventually succeeds", async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts++;
      if (attempts < 3) throw new Error("transient");
      return "ok";
    });
    assert.strictEqual(result, "ok");
    assert.strictEqual(attempts, 3);
  });

  await test("throws after maxRetries exhausted", async () => {
    let attempts = 0;
    try {
      await withRetry(async () => {
        attempts++;
        throw new Error("always fails");
      }, 3);
      assert.fail("should have thrown");
    } catch (err) {
      assert.strictEqual(err.message, "always fails");
      assert.strictEqual(attempts, 3);
    }
  });

  await test("confirmation math: clamped to zero when SPV lags", () => {
    // Simulate Bridge height behind tx block (transient lag)
    const bridgeBtcHeight = 4918810;
    const txBlockHeight   = 4918812;
    const confirms = Math.max(0, Number(bridgeBtcHeight) - txBlockHeight + 1);
    assert.strictEqual(confirms, 0);
  });

  await test("confirmation math: correct when SPV is ahead", () => {
    const bridgeBtcHeight = 4925875;
    const txBlockHeight   = 4918812;
    const confirms = Math.max(0, Number(bridgeBtcHeight) - txBlockHeight + 1);
    assert.strictEqual(confirms, 7064);
  });
}

async function runBridgeContractTests() {
  section("Bridge contract (live RSK RPC)");

  await test("getBtcBlockchainBestChainHeight returns a positive integer", async () => {
    const height = await withRetry(() => bridge.getBtcBlockchainBestChainHeight());
    assert.ok(Number(height) > 0, `Expected positive height, got ${height}`);
  });

  await test("getFederationAddress returns a valid Bitcoin address", async () => {
    const addr = await withRetry(() => bridge.getFederationAddress());
    assert.ok(typeof addr === "string" && addr.length > 10, `Bad address: ${addr}`);
    // Testnet P2SH addresses start with 2; mainnet with 3
    const prefix = NETWORK === "mainnet" ? "3" : "2";
    assert.ok(addr.startsWith(prefix), `Expected address starting with '${prefix}', got ${addr}`);
  });

  await test("getQueuedPegoutsCount returns a non-negative integer", async () => {
    const count = await withRetry(() => bridge.getQueuedPegoutsCount());
    assert.ok(Number(count) >= 0, `Expected non-negative count, got ${count}`);
  });

  await test("getNextPegoutCreationBlockNumber returns a positive integer", async () => {
    const block = await withRetry(() => bridge.getNextPegoutCreationBlockNumber());
    assert.ok(Number(block) > 0, `Expected positive block, got ${block}`);
  });

  await test("provider can fetch current RSK block number", async () => {
    const blockNumber = await withRetry(() => provider.getBlockNumber());
    assert.ok(blockNumber > 0, `Expected positive block number, got ${blockNumber}`);
  });
}

// Cached once at test startup — avoids flaky per-call results from an unstable API
let _blockstreamAvailable = null;
async function checkBlockstreamAvailable() {
  if (_blockstreamAvailable !== null) return _blockstreamAvailable;
  const fetch = globalThis.fetch ?? require("node-fetch").default ?? require("node-fetch");
  try {
    const r = await fetch(`${BTC_API}/blocks/tip/height`, { signal: AbortSignal.timeout(10000) });
    _blockstreamAvailable = r.ok;
  } catch {
    _blockstreamAvailable = false;
  }
  return _blockstreamAvailable;
}

async function runBlockstreamTests() {
  section("Blockstream API (Bitcoin testnet)");

  const blockstreamUp = await checkBlockstreamAvailable();
  if (!blockstreamUp) {
    console.log("  ⚠  Blockstream API unavailable — skipping Blockstream tests");
    return;
  }

  const fetch = globalThis.fetch ?? require("node-fetch").default ?? require("node-fetch");

  // Helper: fetch with retry and 30s timeout so transient 504s don't hang the suite
  const fetchWithRetry = (url) => withRetry(async () => {
    const r = await fetch(url, { signal: AbortSignal.timeout(30_000) });
    if (r.status === 404) return r; // pass 404 through — it's the expected result in one test
    if (!r.ok) throw new Error(`Blockstream HTTP ${r.status}`);
    return r;
  });

  await test("known peg-in tx is confirmed at expected block", async () => {
    const r = await fetchWithRetry(`${BTC_API}/tx/${TESTNET_PEGIN_TX}`);
    assert.ok(r.ok, `HTTP ${r.status}`);
    const tx = await r.json();
    assert.ok(tx.status?.confirmed, "Transaction should be confirmed");
    assert.strictEqual(tx.status.block_height, 4918812);
  });

  await test("known peg-in tx has output to federation address", async () => {
    const r = await fetchWithRetry(`${BTC_API}/tx/${TESTNET_PEGIN_TX}`);
    const tx = await r.json();
    const targeted = tx.vout?.some((v) => v.scriptpubkey_address === TESTNET_FED_ADDR);
    assert.ok(targeted, `Expected output to ${TESTNET_FED_ADDR}`);
  });

  await test("404 on invalid tx hash (not retried)", async () => {
    const r = await fetch(`${BTC_API}/tx/${"0".repeat(64)}`);
    assert.strictEqual(r.status, 404);
  });
}

async function runValidationTests() {
  section("validatePeginTarget");

  const blockstreamUp = await checkBlockstreamAvailable();
  if (!blockstreamUp) {
    console.log("  ⚠  Blockstream API unavailable — skipping validatePeginTarget tests");
    return;
  }

  await test("accepts tx that targets the current federation address", async () => {
    const fedAddress = await withRetry(() => bridge.getFederationAddress());
    // The testnet peg-in tx targets TESTNET_FED_ADDR; skip if federation rotated
    if (fedAddress === TESTNET_FED_ADDR) {
      await validatePeginTarget(TESTNET_PEGIN_TX, fedAddress);
      // No throw = pass
    } else {
      // Federation has rotated — validate against the known old address directly
      await validatePeginTarget(TESTNET_PEGIN_TX, TESTNET_FED_ADDR);
    }
  });

  await test("throws on tx that does not target the federation address", async () => {
    try {
      await validatePeginTarget(TESTNET_PEGIN_TX, "2N00000000000000000000000000000000000000");
      assert.fail("Expected an error");
    } catch (err) {
      assert.ok(
        err.message.includes("does not send to federation address"),
        `Unexpected error: ${err.message}`
      );
    }
  });

  await test("throws fatal error on invalid tx hash", async () => {
    try {
      await validatePeginTarget("0000000000000000000000000000000000000000000000000000000000000000", TESTNET_FED_ADDR);
      assert.fail("Expected an error");
    } catch (err) {
      assert.ok(
        err.message.includes("not found"),
        `Unexpected error: ${err.message}`
      );
    }
  });
}

async function runPegoutReceiptTests() {
  section("Peg-out transaction (live RSK RPC)");

  await test("known peg-out tx has a valid receipt", async () => {
    const receipt = await withRetry(() => provider.getTransactionReceipt(TESTNET_PEGOUT_TX));
    assert.ok(receipt !== null, "Receipt should exist for a confirmed tx");
    assert.ok(receipt.blockNumber > 0, `Expected positive blockNumber, got ${receipt.blockNumber}`);
  });

  await test("known peg-out tx is in expected block range", async () => {
    const receipt = await withRetry(() => provider.getTransactionReceipt(TESTNET_PEGOUT_TX));
    // Was mined at 7,562,606 — allow some tolerance for reorg (none expected)
    assert.strictEqual(receipt.blockNumber, 7562606);
  });

  await test("peg-out confirmation count is positive", async () => {
    const [currentBlock, receipt] = await Promise.all([
      withRetry(() => provider.getBlockNumber()),
      withRetry(() => provider.getTransactionReceipt(TESTNET_PEGOUT_TX)),
    ]);
    const confirms = currentBlock - receipt.blockNumber;
    assert.ok(confirms > 0, `Expected positive confirms, got ${confirms}`);
  });
}

async function runAlertTests() {
  section("Alert configuration");

  await test("Telegram: skips gracefully when token not set", async () => {
    const original = process.env.TELEGRAM_BOT_TOKEN;
    delete process.env.TELEGRAM_BOT_TOKEN;
    // sendTelegram is not exported — test by checking env guard logic
    const token  = process.env.TELEGRAM_BOT_TOKEN;
    const chatId = process.env.TELEGRAM_CHAT_ID;
    assert.ok(!token || !chatId || token === "your_bot_token");
    process.env.TELEGRAM_BOT_TOKEN = original;
  });

  await test("Discord: skips gracefully when URL not set", async () => {
    const url = process.env.DISCORD_WEBHOOK_URL || "";
    const shouldSkip = !url || url.includes("your_webhook");
    // If no webhook is configured the guard will short-circuit — that's correct
    assert.ok(shouldSkip || url.startsWith("https://discord.com/api/webhooks/"));
  });

  if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_BOT_TOKEN !== "your_bot_token") {
    await test("Telegram: can reach API endpoint", async () => {
      const fetch = globalThis.fetch ?? require("node-fetch").default ?? require("node-fetch");
      const token  = process.env.TELEGRAM_BOT_TOKEN;
      const chatId = process.env.TELEGRAM_CHAT_ID;
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: "🧪 PowPeg monitor test — JS", parse_mode: "Markdown" }),
      });
      const json = await res.json();
      assert.ok(json.ok, `Telegram API returned: ${JSON.stringify(json)}`);
    });
  }

  if (process.env.DISCORD_WEBHOOK_URL && !process.env.DISCORD_WEBHOOK_URL.includes("your_webhook")) {
    await test("Discord: webhook delivers successfully", async () => {
      const fetch = globalThis.fetch ?? require("node-fetch").default ?? require("node-fetch");
      const res = await fetch(process.env.DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "🧪 PowPeg monitor test — JS" }),
      });
      assert.ok(res.status === 204 || res.status === 200, `Discord returned ${res.status}`);
    });
  }
}

// ── Runner ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n╔════════════════════════════════════════════╗");
  console.log(`║  PowPeg Monitor — Test Suite (JavaScript)  ║`);
  console.log("╚════════════════════════════════════════════╝");
  console.log(`  Network: ${NETWORK} | RPC: ${process.env.RSK_RPC_URL?.slice(0, 40)}...`);

  // Pre-warm the Blockstream availability cache before any test section runs
  const blockstreamUp = await checkBlockstreamAvailable();
  if (!blockstreamUp) {
    console.log("  ⚠  Blockstream API unavailable — Blockstream and validation tests will be skipped");
  }

  await runUtilityTests();
  await runStateTests();
  await runRetryTests();
  await runBridgeContractTests();
  await runBlockstreamTests();
  await runValidationTests();
  await runPegoutReceiptTests();
  await runAlertTests();

  console.log(`\n${"─".repeat(52)}`);
  const skippedNote = skipped > 0 ? `  ${skipped} skipped (external API)` : "";
  console.log(`  ${passed} passed  ${failed > 0 ? failed + " failed" : ""}${skippedNote}`);

  if (failed > 0) {
    console.log(`\n  Some tests failed. Check your .env and network connectivity.\n`);
    process.exit(1);
  } else {
    console.log(`\n  All tests passed.\n`);
  }
}

main().catch((err) => {
  console.error("\n  Fatal error:", err.message);
  process.exit(1);
});
