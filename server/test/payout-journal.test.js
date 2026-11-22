// ── A payout survives the server stopping half-way ───────────────────────────
// Found by the November audit, each reproduced first:
//  • killed after sending, before recording: the chain had the payout, the server
//    didn't, and the next reading paid the same days again;
//  • a lost answer from storage while taking the guard left it taken for 20 hours
//    with nothing paid ("already paid recently" on every claim);
//  • a sent-but-unconfirmed payout was remembered in memory only.
// Now a payout is journaled after signing and before sending, settled from the
// chain by whichever process is running, and guards are short until committed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { startServer, stateWithBaseline, fakeNode, WALLET } from "./helpers.mjs";
import { fakeUpstash } from "./fakeredis.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const COOL = `greenutilitylog:state:once:cool:${WALLET.toLowerCase()}:electric`;
const withLink = () => {
  const s = stateWithBaseline({ reading: 1000 });
  s.meterLinks = { tok: { address: WALLET.toLowerCase(), meterNo: "E1000", utility: "electric", createdAt: Date.now() } };
  return s;
};
function pidOnPort(port) {
  for (const d of readdirSync("/proc")) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const env = readFileSync(`/proc/${d}/environ`, "utf8").split("\0");
      if (env.includes(`PORT=${port}`) && readFileSync(`/proc/${d}/cmdline`, "utf8").includes("index.js")) return Number(d);
    } catch { /* gone */ }
  }
  return null;
}
async function until(pred, ms = 15000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await pred()) return true; await sleep(200); }
  return false;
}
const chainEnv = (redis, node) => ({
  UPSTASH_REDIS_REST_URL: redis.url, UPSTASH_REDIS_REST_TOKEN: "t", AUTO_CLAIM_ON_PUSH: "on",
  DISTRIBUTOR_DRY_RUN: "", NODE_URL: node.url, DISTRIBUTOR_PRIVATE_KEY: randomBytes(32).toString("hex"),
  BROADCAST_RETRY_MS: "50", RECEIPT_WAIT_MS: "3000",
  JOURNAL_CHECK_MS: "1000", JOURNAL_SETTLE_AFTER_MS: "0", JOURNAL_GIVE_UP_MS: "1500",
});

test("killed right after sending: the next process records it from the chain, and pays nothing twice", async () => {
  const redis = await fakeUpstash(withLink());
  let srvA = null;
  // The node takes the transaction, and the server is killed at that moment.
  const node = await fakeNode("ok", { onPost: () => { const pid = pidOnPort(new URL(srvA.base).port); if (pid) process.kill(pid, "SIGKILL"); } });
  const env = chainEnv(redis, node);
  srvA = await startServer({ env });
  await srvA.post("/meter-ingest", { token: "tok", reading: 1003 });
  assert.ok(await until(() => node.raws.length === 1), "payout #1 sent");
  await sleep(500);
  let st = redis.state();
  assert.equal(st.readings["electric:e1000"], 1000, "killed before recording");
  assert.equal(Object.keys(st.payouts || {}).length, 1, "but the journal has it");
  // The guard was taken for one attempt only, not for the 20-hour cooldown.
  const pttl = (await (await fetch(redis.url, { method: "POST", body: JSON.stringify(["PTTL", COOL]) })).json()).result;
  assert.ok(pttl > 0 && pttl <= 15 * 60 * 1000, `guard TTL ${pttl}`);
  const b = await startServer({ env });
  try {
    assert.ok(await until(() => redis.state().readings?.["electric:e1000"] === 1003), "recorded from the chain");
    st = redis.state();
    assert.ok(st.cooldowns[`${WALLET.toLowerCase()}:electric`] > 0, "its cooldown started");
    assert.equal(Object.keys(st.payouts || {}).length, 0, "journal cleared");
    // Flags are kept in a part of their own (store.js).
    const flags = JSON.parse(redis.kv.get("greenutilitylog:state:part:flags") || "{}").flags || {};
    assert.ok(Object.keys(flags).some((k) => k.startsWith("recovered-")), "flagged for the admin");
    // A newer reading in the cooldown is not paid again.
    await b.post("/meter-ingest", { token: "tok", reading: 1006 });
    await sleep(1500);
    assert.equal(node.raws.length, 1, "no second payout");
  } finally { await b.stop(); redis.srv.close(); node.srv.close(); }
});

test("signed but it never arrived: the meter waits, then is free again once the transaction can't land", async () => {
  const redis = await fakeUpstash(withLink());
  // Every broadcast is refused and the node never knows the transaction.
  const node = await fakeNode("refused");
  const env = { ...chainEnv(redis, node), JOURNAL_GIVE_UP_MS: "4000", AUTO_CLAIM_ON_PUSH: "off" };
  const srv = await startServer({ env });
  try {
    await srv.post("/meter-ingest", { token: "tok", reading: 1003 });
    const r1 = await srv.post("/reward-from-meter", { address: WALLET, meterNo: "E1000" });
    // Nothing went out as far as the node can tell; the journal keeps it until that's certain.
    assert.ok(await until(() => Object.keys(redis.state().payouts || {}).length === 1), `journaled (${r1.status} ${JSON.stringify(r1.body)})`);
    const r2 = await srv.post("/reward-from-meter", { address: WALLET, meterNo: "E1000" });
    assert.equal(r2.status, 409, JSON.stringify(r2.body));
    assert.match(r2.body.error, /still being confirmed/);
    // Past the give-up time and still unknown to the node: dropped, nothing recorded as paid.
    assert.ok(await until(() => Object.keys(redis.state().payouts || {}).length === 0), "dropped");
    assert.equal(redis.state().readings["electric:e1000"], 1000);
    assert.equal(redis.state().cooldowns?.[`${WALLET.toLowerCase()}:electric`], undefined);
  } finally { await srv.stop(); redis.srv.close(); node.srv.close(); }
});

test("an answer from storage lost while taking the guard: the guard is given back, the next claim pays", async () => {
  const redis = await fakeUpstash(withLink());
  const srv = await startServer({ env: { UPSTASH_REDIS_REST_URL: redis.url, UPSTASH_REDIS_REST_TOKEN: "t", AUTO_CLAIM_ON_PUSH: "on", REDIS_TIMEOUT_MS: "500" } });
  try {
    redis.delayReply("SET", /:once:cool:/, 1500);   // Redis ran it; the answer comes too late
    assert.equal((await srv.post("/meter-ingest", { token: "tok", reading: 1003 })).status, 200);
    await sleep(2500);
    assert.match(srv.logs(), /once-guard unavailable/);
    assert.ok(!redis.once().includes(COOL), "the guard isn't left behind");
    const r = await srv.post("/reward-from-meter", { address: WALLET, meterNo: "E1000" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.amount > 0, JSON.stringify(r.body));
  } finally { await srv.stop(); redis.srv.close(); }
});

test("a normal payout: the guard is lengthened to the full cooldown, the journal ends empty", async () => {
  const redis = await fakeUpstash(withLink());
  const srv = await startServer({ env: { UPSTASH_REDIS_REST_URL: redis.url, UPSTASH_REDIS_REST_TOKEN: "t", JOURNAL_CHECK_MS: "1000" } });
  try {
    await srv.post("/meter-ingest", { token: "tok", reading: 1003 });
    const r = await srv.post("/reward-from-meter", { address: WALLET, meterNo: "E1000" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const pttl = (await (await fetch(redis.url, { method: "POST", body: JSON.stringify(["PTTL", COOL]) })).json()).result;
    assert.ok(pttl > 19 * 3600e3, `guard TTL ${pttl}`);
    assert.ok(await until(() => Object.keys(redis.state().payouts || {}).length === 0), "journal empty once confirmed");
  } finally { await srv.stop(); redis.srv.close(); }
});

test("a shutdown while the guard is being taken: the payout is finished first, no guard left without a payout", async () => {
  const redis = await fakeUpstash(withLink());
  const srv = await startServer({ env: { UPSTASH_REDIS_REST_URL: redis.url, UPSTASH_REDIS_REST_TOKEN: "t", AUTO_CLAIM_ON_PUSH: "on" } });
  redis.delayReply("SET", /:once:read:/, 2500);     // a slow answer on the second guard key
  assert.equal((await srv.post("/meter-ingest", { token: "tok", reading: 1003 })).status, 200);
  await sleep(300);
  await srv.stop();                                   // SIGTERM, as a deploy sends
  const st = redis.state();
  // Either paid and recorded, or nothing held: never a guard without a payout.
  if (redis.once().includes(COOL)) assert.equal(st.readings["electric:e1000"], 1003, "a held guard means a recorded payout");
  assert.match(srv.logs(), /\[auto-pay:push\] .*\+[\d.]+ B3TR/, "the payout was finished");
  redis.srv.close();
});
