#!/usr/bin/env node
// monitor/src/index.js
//
// SolnadoCash watcher. Reads on-chain state, evaluates the rules in checks.js, and alerts.
//
// Design notes
// ───────────
// * Cheap by construction: two account reads per pool plus one for the program authority.
//   Polling every 60s sits inside any free RPC tier.
// * Detection speed is deliberately not the goal. Total outflow is already capped at total
//   deposits by the vault-balance guard in withdraw.rs, so loss is bounded whether or not
//   anyone is watching. The value here is learning about a problem BEFORE it is exploited,
//   so you can pause deposits and tell people to withdraw.
// * Baselines for immutable fields are recorded on first run and compared thereafter, so
//   the monitor detects drift without being told what to expect.
//
// Usage:
//   node src/index.js --once      # single pass, exit 0 clean / 1 if CRITICAL — for cron
//   node src/index.js             # daemon, polls every INTERVAL_SECONDS
//
// Configure with environment variables; see .env.example.

import { Connection, PublicKey } from "@solana/web3.js";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import {
  runPoolChecks, checkAuthorities, checkRelayerBalance, CRITICAL, WARNING,
} from "./checks.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── configuration ───────────────────────────────────────────────────────────
const RPC_URL = process.env.SOLANA_RPC_URL || "https://api.devnet.solana.com";
const PROGRAM_ID = new PublicKey(
  process.env.PROGRAM_ID || "DMAPWBXb5w2KZkML2SyV2CtZDfbwNKqkWL3scQKXUF59"
);
const POOLS = (process.env.POOLS || "").split(",").map((s) => s.trim()).filter(Boolean);
const RELAYER_PUBKEY = process.env.RELAYER_PUBKEY || null;
const EXPECTED_UPGRADE_AUTHORITY = process.env.EXPECTED_UPGRADE_AUTHORITY || undefined;
const INTERVAL_SECONDS = Number(process.env.INTERVAL_SECONDS || 60);
const STATE_PATH = process.env.STATE_PATH || join(__dirname, "../state.json");
const ALERT_COOLDOWN_MINUTES = Number(process.env.ALERT_COOLDOWN_MINUTES || 30);
const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const TELEGRAM_CHAT = process.env.TELEGRAM_CHAT_ID || null;

// Pool account offsets, including the 8-byte discriminator (see state.rs).
const OFF_ADMIN = 8;
const OFF_DENOM = 8 + 64;
const OFF_NEXT_INDEX = 8 + 80;
const OFF_TREASURY = 8 + 88;
const OFF_IS_PAUSED = 8 + 123;
const POOL_LEN = 8 + 8968;
const POOL_DISCRIMINATOR = Buffer.from([0xf1, 0x9a, 0x6d, 0x04, 0x11, 0xb1, 0x6d, 0xbc]);
const VAULT_SPACE = 8; // vault is created with space = 8

// ── state ───────────────────────────────────────────────────────────────────
function loadState() {
  try {
    return JSON.parse(readFileSync(STATE_PATH, "utf8"));
  } catch {
    return { pools: {}, alerts: {} };
  }
}
function saveState(state) {
  try {
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    writeFileSync(STATE_PATH, JSON.stringify(state, null, 1));
  } catch (e) {
    console.error(`[monitor] could not persist state to ${STATE_PATH}: ${e.message}`);
  }
}

// ── alerting ────────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  if (!TELEGRAM_TOKEN || !TELEGRAM_CHAT) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: TELEGRAM_CHAT, text, disable_web_page_preview: true }),
    });
    if (!res.ok) {
      console.error(`[monitor] telegram send failed: ${res.status}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[monitor] telegram send error: ${e.message}`);
    return false;
  }
}

/**
 * Emit findings. CRITICAL always alerts — suppressing those is how an incident gets
 * missed. WARNING and INFO are rate-limited per (code, pool) so a persistent condition
 * does not turn into a notification flood you learn to ignore.
 */
async function emit(findings, state) {
  const now = Date.now();
  const cooldownMs = ALERT_COOLDOWN_MINUTES * 60_000;
  let criticals = 0;

  for (const f of findings) {
    const key = `${f.code}:${f.pool ?? "-"}`;
    const line = `[${f.severity}] ${f.pool ? f.pool + ": " : ""}${f.message}`;

    if (f.severity === CRITICAL) {
      criticals++;
      console.error(line);
      await sendTelegram(`\u{1F6A8} SolnadoCash ${f.severity}\n\n${line}`);
      state.alerts[key] = now;
      continue;
    }

    const last = state.alerts[key] ?? 0;
    if (now - last < cooldownMs) {
      console.log(`${line}  (alert suppressed, cooldown)`);
      continue;
    }
    console.log(line);
    if (f.severity === WARNING) {
      await sendTelegram(`\u{26A0}\u{FE0F} SolnadoCash ${f.severity}\n\n${line}`);
    }
    state.alerts[key] = now;
  }
  return criticals;
}

// ── chain reads ─────────────────────────────────────────────────────────────
async function readUpgradeAuthority(connection) {
  const [programData] = PublicKey.findProgramAddressSync(
    [PROGRAM_ID.toBytes()],
    new PublicKey("BPFLoaderUpgradeab1e11111111111111111111111")
  );
  const info = await connection.getAccountInfo(programData);
  if (!info) return undefined; // not an upgradeable program (or not deployed)
  // ProgramData layout: 4-byte enum, 8-byte slot, 1-byte Option tag, 32-byte pubkey
  const hasAuthority = info.data[12] === 1;
  return hasAuthority ? new PublicKey(info.data.subarray(13, 45)).toBase58() : null;
}

async function readPool(connection, address) {
  const pool = new PublicKey(address);
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from("vault"), pool.toBytes()],
    PROGRAM_ID
  );
  const [info, vaultLamports, vaultRent] = await Promise.all([
    connection.getAccountInfo(pool),
    connection.getBalance(vault),
    connection.getMinimumBalanceForRentExemption(VAULT_SPACE),
  ]);

  if (!info) return { address, error: "pool account not found" };
  if (!info.owner.equals(PROGRAM_ID)) return { address, error: `owned by ${info.owner.toBase58()}` };
  if (info.data.length < POOL_LEN || !info.data.subarray(0, 8).equals(POOL_DISCRIMINATOR)) {
    return { address, error: "not a Pool account" };
  }

  const denomination = info.data.readBigUInt64LE(OFF_DENOM);
  return {
    address,
    label: `${Number(denomination) / 1e9} SOL`,
    denomination,
    deposits: info.data.readBigUInt64LE(OFF_NEXT_INDEX),
    vaultLamports: BigInt(vaultLamports),
    vaultRent: BigInt(vaultRent),
    isPaused: info.data[OFF_IS_PAUSED] === 1,
    admin: new PublicKey(info.data.subarray(OFF_ADMIN, OFF_ADMIN + 32)).toBase58(),
    treasury: new PublicKey(info.data.subarray(OFF_TREASURY, OFF_TREASURY + 32)).toBase58(),
  };
}

// ── one pass ────────────────────────────────────────────────────────────────
async function runOnce(connection, state) {
  const findings = [];
  const poolsForAuthority = [];

  for (const address of POOLS) {
    let pool;
    try {
      pool = await readPool(connection, address);
    } catch (e) {
      findings.push({ severity: WARNING, code: "RPC_ERROR", pool: address,
        message: `could not read pool: ${e.message}` });
      continue;
    }
    if (pool.error) {
      findings.push({ severity: CRITICAL, code: "POOL_UNREADABLE", pool: address,
        message: pool.error });
      continue;
    }

    const prev = state.pools[address];
    findings.push(...runPoolChecks(pool, prev));

    // Baseline immutable fields on first sight, compare thereafter.
    poolsForAuthority.push({
      label: pool.label,
      baseline: prev?.baseline ?? {
        admin: pool.admin, treasury: pool.treasury,
        denomination: pool.denomination.toString(),
      },
      current: {
        admin: pool.admin, treasury: pool.treasury,
        denomination: pool.denomination.toString(),
      },
    });

    state.pools[address] = {
      label: pool.label,
      vaultLamports: pool.vaultLamports.toString(),
      deposits: pool.deposits.toString(),
      isPaused: pool.isPaused,
      baseline: prev?.baseline ?? {
        admin: pool.admin, treasury: pool.treasury,
        denomination: pool.denomination.toString(),
      },
      lastSeen: new Date().toISOString(),
    };

    console.log(
      `  ${pool.label.padEnd(9)} deposits=${String(pool.deposits).padStart(6)} ` +
      `vault=${(Number(pool.vaultLamports) / 1e9).toFixed(4)} SOL` +
      `${pool.isPaused ? "  [PAUSED]" : ""}`
    );
  }

  let actualAuthority;
  try {
    actualAuthority = await readUpgradeAuthority(connection);
  } catch (e) {
    findings.push({ severity: WARNING, code: "RPC_ERROR",
      message: `could not read upgrade authority: ${e.message}` });
  }
  findings.push(...checkAuthorities({
    expectedUpgradeAuthority: EXPECTED_UPGRADE_AUTHORITY,
    actualUpgradeAuthority: actualAuthority,
    pools: poolsForAuthority,
  }));

  if (RELAYER_PUBKEY) {
    try {
      const balance = BigInt(await connection.getBalance(new PublicKey(RELAYER_PUBKEY)));
      console.log(`  relayer   balance=${(Number(balance) / 1e9).toFixed(4)} SOL`);
      findings.push(...checkRelayerBalance({ balance }));
    } catch (e) {
      findings.push({ severity: WARNING, code: "RPC_ERROR",
        message: `could not read relayer balance: ${e.message}` });
    }
  }

  const criticals = await emit(findings, state);
  saveState(state);
  return { findings, criticals };
}

// ── entry point ─────────────────────────────────────────────────────────────
async function main() {
  if (POOLS.length === 0) {
    console.error("ERROR: set POOLS to a comma-separated list of pool addresses. See .env.example.");
    process.exit(2);
  }
  const once = process.argv.includes("--once");
  const connection = new Connection(RPC_URL, "confirmed");
  const state = loadState();

  console.log(`[monitor] rpc=${RPC_URL}`);
  console.log(`[monitor] program=${PROGRAM_ID.toBase58()} pools=${POOLS.length}`);
  console.log(`[monitor] telegram=${TELEGRAM_TOKEN && TELEGRAM_CHAT ? "on" : "OFF (console only)"}`);
  if (!EXPECTED_UPGRADE_AUTHORITY) {
    console.log("[monitor] EXPECTED_UPGRADE_AUTHORITY unset — cannot detect a key takeover. Set it.");
  }

  if (once) {
    const { criticals } = await runOnce(connection, state);
    process.exit(criticals > 0 ? 1 : 0);
  }

  for (;;) {
    try {
      await runOnce(connection, state);
    } catch (e) {
      // Never let a transient failure kill the watcher; a dead monitor is worse than a
      // noisy one because it fails silently.
      console.error(`[monitor] pass failed: ${e.message}`);
    }
    await new Promise((r) => setTimeout(r, INTERVAL_SECONDS * 1000));
  }
}

main().catch((e) => {
  console.error("FATAL:", e.message || e);
  process.exit(2);
});
