// ── Paths that had no test: a restart mid-payout, and two admin endpoints ─────
// A redeploy sends SIGTERM while a payout can be on its way to the chain; the
// admin can look at the photo behind a payout and move B3TR into the rewards pool.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { ABIFunction } from "@vechain/sdk-core";
import { startServer, photo, stateWithBaseline, fakeNode, adminSigner, WALLET } from "./helpers.mjs";

const DISTRIBUTOR = { DISTRIBUTOR_DRY_RUN: "", DISTRIBUTOR_PRIVATE_KEY: randomBytes(32).toString("hex"), RECEIPT_WAIT_MS: "2000", BROADCAST_RETRY_MS: "50" };
const submit = (srv, tag, reading = 1005) => srv.post("/reward", {
  utility: "electric", meterNo: "E1000", address: WALLET, reading, prevRead: 1000, photo: photo(tag), photoMime: "image/jpeg",
});

// ── Restart while a payout is being sent ──────────────────────────────────────
describe("SIGTERM while a payout is on its way to the chain", () => {
  let srv, node, posted;
  before(async () => {
    posted = new Promise((r) => { node = fakeNode("ok", { postDelayMs: 1500, onPost: r }); });
    node = await node;
    srv = await startServer({ state: stateWithBaseline(), env: { ...DISTRIBUTOR, NODE_URL: node.url } });
  });
  after(() => { node.srv.close(); });

  test("the payout finishes and is recorded, new ones are turned away, then it exits", async () => {
    const paying = submit(srv, "in-flight");
    await posted; // the transaction is at the node, its answer held back
    const stopping = srv.stop({ keepDir: true });
    await new Promise((r) => setTimeout(r, 200));
    const late = await srv.post("/reward", { utility: "electric", meterNo: "E1000", address: WALLET, reading: 1006, prevRead: 1000, photo: photo("late"), photoMime: "image/jpeg" })
      .catch(() => ({ status: "refused" }));
    const r = await paying;
    await stopping;
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.txid, "the payout that was under way still answers with its transaction");
    assert.ok(late.status === 503 || late.status === "refused", `a new payout during shutdown is refused (got ${late.status})`);
    const st = srv.readState();
    assert.equal(st.readings["electric:e1000"], 1005, "the paid reading is saved before the process exits");
    assert.ok(st.cooldowns[`${WALLET.toLowerCase()}:electric`] > 0, "and so is the cooldown, so a restart can't pay it again");
  });
});

// ── /admin/move-rewards-pool ──────────────────────────────────────────────────
const INCREASE = { name: "increaseRewardsPoolBalance", type: "function", stateMutability: "nonpayable", inputs: [{ name: "appId", type: "bytes32" }, { name: "amount", type: "uint256" }], outputs: [] };
const selector = new ABIFunction(INCREASE).encodeData(["0x" + "0".repeat(64), 0]).toString().slice(0, 10);

describe("/admin/move-rewards-pool", () => {
  let admin;
  before(async () => { admin = await adminSigner(); });

  test("only an admin, with a certificate for this action, and a sane amount", async () => {
    const node = await fakeNode("ok");
    const srv = await startServer({ state: stateWithBaseline(), env: { ...DISTRIBUTOR, NODE_URL: node.url, ADMIN_WALLETS: admin.address.toLowerCase() } });
    try {
      const notAdmin = await srv.post("/admin/move-rewards-pool", { address: WALLET, amount: 10 });
      assert.equal(notAdmin.status, 403);
      const otherAction = await srv.post("/admin/move-rewards-pool", { address: admin.address, amount: 10, certificate: await admin.cert("/admin/move-rewards-pool", { amount: 1 }) });
      assert.equal(otherAction.status, 401, "a certificate signed for 1 B3TR can't move 10");
      for (const amount of [0, -5, 2_000_000, "lots"]) {
        assert.equal((await admin.call(srv, "/admin/move-rewards-pool", { amount })).status, 400, `amount ${amount}`);
      }
      assert.equal(node.raws.length, 0, "nothing was sent");
      const ok = await admin.call(srv, "/admin/move-rewards-pool", { amount: 25 });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.match(ok.body.txid, /^0x[0-9a-f]{64}$/);
      assert.equal(ok.body.amount, 25);
      assert.equal(node.raws.length, 1, "one transaction");
    } finally { await srv.stop(); node.srv.close(); }
  });

  test("a move the chain would refuse is not sent", async () => {
    const node = await fakeNode("ok", { revertSelector: selector });
    const srv = await startServer({ state: stateWithBaseline(), env: { ...DISTRIBUTOR, NODE_URL: node.url, ADMIN_WALLETS: admin.address.toLowerCase() } });
    try {
      const r = await admin.call(srv, "/admin/move-rewards-pool", { amount: 25 });
      assert.equal(r.status, 502);
      assert.equal(node.raws.length, 0, "the simulation said it would revert, so nothing went out");
    } finally { await srv.stop(); node.srv.close(); }
  });

  test("without a distributor key it fails plainly", async () => {
    const srv = await startServer({ state: stateWithBaseline(), env: { ADMIN_WALLETS: admin.address.toLowerCase() } });
    try {
      const r = await admin.call(srv, "/admin/move-rewards-pool", { amount: 25 });
      assert.equal(r.status, 502);
      assert.equal(r.body.error, "move failed");
    } finally { await srv.stop(); }
  });
});

// ── /admin/photo ──────────────────────────────────────────────────────────────
// The archive runs on Upstash here (the same REST API the state uses), faked.
function upstash(initial) {
  const kv = new Map(Object.entries(initial));
  const srv = createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      const args = JSON.parse(b || "[]");
      const [cmd] = args;
      let result = null;
      if (cmd === "GET") result = kv.get(args[1]) ?? null;
      else if (cmd === "MGET") result = args.slice(1).map((k) => kv.get(k) ?? null);
      else if (cmd === "SET") {
        if (args.includes("NX") && kv.has(args[1])) result = null;
        else { kv.set(args[1], args[2]); result = "OK"; }
      } else if (cmd === "DEL") { result = kv.delete(args[1]) ? 1 : 0; }
      else if (cmd === "EVAL") {
        const [, , , key, vkey, expected, blob] = args;
        if ((kv.get(vkey) || "0") === expected) {
          kv.set(key, blob);
          const v = String(Number(kv.get(vkey) || "0") + 1);
          kv.set(vkey, v); result = Number(v);
        } else result = 0;
      }
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ result }));
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, kv, url: `http://127.0.0.1:${srv.address().port}` })));
}

describe("/admin/photo", () => {
  let srv, up, admin, txid;
  before(async () => {
    admin = await adminSigner();
    up = await upstash({ "t:photos": JSON.stringify(stateWithBaseline()) });
    srv = await startServer({
      state: stateWithBaseline(),
      env: { UPSTASH_REDIS_REST_URL: up.url, UPSTASH_REDIS_REST_TOKEN: "t", STATE_KEY: "t:photos", ADMIN_WALLETS: admin.address.toLowerCase() },
    });
  });
  after(async () => { await srv.stop(); up.srv.close(); });

  test("shows the photo behind a payout", async () => {
    const r = await submit(srv, "archived");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    txid = r.body.txid;
    // Archiving is fire-and-forget after the answer: wait for it to land.
    for (let i = 0; i < 50 && ![...up.kv.keys()].some((k) => k.startsWith("photo:")); i++) await new Promise((res) => setTimeout(res, 100));
    const p = await admin.call(srv, "/admin/photo", { txid });
    assert.equal(p.status, 200, JSON.stringify(p.body));
    assert.equal(p.body.found, true);
    assert.match(p.body.dataUrl, /^data:image\/(jpeg|webp|png);base64,/);
  });

  test("is admin-only, and the certificate must name this txid", async () => {
    assert.equal((await srv.post("/admin/photo", { address: WALLET, txid })).status, 403);
    const other = await srv.post("/admin/photo", { address: admin.address, txid, certificate: await admin.cert("/admin/photo", { txid: "0x" + "9".repeat(64) }) });
    assert.equal(other.status, 401);
    const once = await admin.cert("/admin/photo", { txid });
    assert.equal((await srv.post("/admin/photo", { address: admin.address, txid, certificate: once })).status, 200);
    assert.equal((await srv.post("/admin/photo", { address: admin.address, txid, certificate: once })).status, 401, "a certificate works once");
  });

  test("tells a photo that expired from one that was never archived", async () => {
    const never = await admin.call(srv, "/admin/photo", { txid: "0x" + "7".repeat(64) });
    assert.deepEqual([never.body.found, never.body.reason], [false, "never-archived"]);
    for (const k of [...up.kv.keys()]) if (k.startsWith("photo:")) up.kv.delete(k); // the retention TTL ran out
    const expired = await admin.call(srv, "/admin/photo", { txid });
    assert.deepEqual([expired.body.found, expired.body.reason], [false, "expired"]);
  });

  test("without an archive it says so instead of failing", async () => {
    const plain = await startServer({ state: stateWithBaseline(), env: { ADMIN_WALLETS: admin.address.toLowerCase() } });
    try {
      const r = await admin.call(plain, "/admin/photo", { txid: "0x" + "1".repeat(64) });
      assert.equal(r.status, 200);
      assert.deepEqual([r.body.enabled, r.body.found], [false, false]);
    } finally { await plain.stop(); }
  });
});
