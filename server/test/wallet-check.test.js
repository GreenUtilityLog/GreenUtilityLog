// ── The wallet check: history on chain, who funded it, the passport ──────────
// A fake VeChain node answers the log queries. Wallets topped up from one source
// are recorded for the admin; in "base" mode a meter payout to such a wallet is
// held to the base amount. A node that can't be read never blocks a payout.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startServer, photo, stateWithBaseline } from "./helpers.mjs";

const FUNDER = "0x" + "f".repeat(40);
const W = ["0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222",
  "0x3333333333333333333333333333333333333333", "0x4444444444444444444444444444444444444444"];

// Every wallet got its first VET from FUNDER yesterday and never sent anything.
async function fakeNode({ broken = false } = {}) {
  const srv = createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (broken) { res.statusCode = 500; return res.end("{}"); }
      if (req.url.startsWith("/logs/transfer")) {
        const c = JSON.parse(b || "{}").criteriaSet?.[0] || {};
        if (c.recipient) return res.end(JSON.stringify([{ sender: FUNDER, recipient: c.recipient, meta: { blockTimestamp: Math.floor(Date.now() / 1000) - 86400 } }]));
        return res.end("[]");
      }
      if (req.url.startsWith("/logs/event")) return res.end("[]");
      res.end(JSON.stringify({ data: "0x", reverted: false }));   // passport reads: nothing
    });
  });
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  return { srv, url: `http://127.0.0.1:${srv.address().port}` };
}

function state() {
  const s = stateWithBaseline({ wallet: W[0], meterNo: "E1" });
  W.forEach((w, i) => { const k = `electric:e${i + 1}`; s.meterOwners[k] = w; s.readings[k] = 1000; s.readingAts[k] = Date.now() - 86400000; });
  return s;
}
const submit = (srv, i) => srv.post("/reward", {
  utility: "electric", meterNo: `E${i + 1}`, address: W[i], reading: 1001, prevRead: 1000, photo: photo(`wc${i}`), photoMime: "image/jpeg",
});
const flagsOf = (srv, addr) => Object.values(srv.readState().flags || {}).filter((f) => f.addr === addr).map((f) => f.reason).join(" | ");

describe("wallet check, base mode", () => {
  let srv, node;
  before(async () => {
    node = await fakeNode();
    srv = await startServer({ state: state(), env: { WALLET_CHECK: "base", WALLET_FUNDER_FLAG: "3", NODE_URL: node.url } });
  });
  after(async () => { await srv.stop(); node.srv.close(); });

  test("the first wallets from one source are paid in full, and the funder is recorded", async () => {
    for (const i of [0, 1]) {
      const r = await submit(srv, i);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.ok(r.body.amount > 1, `full amount, got ${r.body.amount}`);
    }
    assert.equal(srv.readState().walletChecks[W[1]].f, FUNDER);
  });

  test("the third wallet from that source is held to the base amount and flagged for the admin", async () => {
    const r = await submit(srv, 2);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.amount, 0.2);
    await srv.waitForState((s) => Object.values(s.flags || {}).some((f) => f.addr === W[2]));
    assert.match(flagsOf(srv, W[2]), /funded by 0xffff…ffff, like 2 other wallets here/);
    assert.match(flagsOf(srv, W[2]), /held to the base amount/);
  });

  test("is in /health", async () => {
    assert.equal((await srv.get("/health")).body.walletCheck, "base");
  });
});

describe("wallet check, node unreadable", () => {
  let srv, node;
  before(async () => {
    node = await fakeNode({ broken: true });
    srv = await startServer({ state: state(), env: { WALLET_CHECK: "base", NODE_URL: node.url } });
  });
  after(async () => { await srv.stop(); node.srv.close(); });

  test("never blocks or shrinks a payout, and tries again next time", async () => {
    const r = await submit(srv, 3);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(r.body.amount > 1);
    assert.equal(srv.readState().walletChecks?.[W[3]], undefined);
  });
});
