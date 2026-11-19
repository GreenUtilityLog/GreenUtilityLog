// ── Signals reset by the VeBetterDAO Foundation after KYC ──────────────────────
// Such a wallet has 0 signals and passes the member check. The owner's choice: let
// it earn, but show it to the admin — a flag once it is let in (connect, payout,
// automatic payout), and a line in the admin's lookup. A wallet that is NOT let in
// isn't flagged "allowed in". Only a reset sent by the Foundation wallet WITH the KYC reason
// counts; the same reason from anyone else, or another reason from the Foundation,
// doesn't.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { ABIEvent, ABIFunction } from "@vechain/sdk-core";
import { startServer, adminSigner } from "./helpers.mjs";
import { KYC_RESETTER, KYC_REASON } from "../galaxy.js";

const PASSPORT = "0x592c756df7a5d39de1735030e8b9c18b7417e6c4"; // testnet
const TOPIC = new ABIEvent({ type: "event", name: "UserSignalsReset", anonymous: false,
  inputs: [{ name: "user", type: "address", indexed: true }, { name: "reason", type: "string", indexed: false }] }).signatureHash;
function word(n) { return BigInt(n).toString(16).padStart(64, "0"); }
const str = (s) => { const b = Buffer.from(s, "utf8"); return "0x" + word(32) + word(b.length) + b.toString("hex").padEnd(Math.ceil(b.length / 32) * 64, "0"); };

const KYC = "0x" + "c1".repeat(20), OTHER_ORIGIN = "0x" + "c2".repeat(20), OTHER_REASON = "0x" + "c3".repeat(20), PLAIN = "0x" + "c4".repeat(20);
// Reset by the Foundation like KYC, but without a GM NFT: not let in, so not flagged.
const KYC_NO_GM = "0x" + "c5".repeat(20);
// Every wallet here passes VeBetterDAO's member check (GM NFT #<byte> of level 2,
// voted last round, no signals, its own Passport) except KYC_NO_GM.
const sel = (name, types) => new ABIFunction({ name, type: "function", stateMutability: "view", inputs: types.map((t, i) => ({ name: `a${i}`, type: t })), outputs: [] }).signatureHash.slice(0, 10);
const S = {
  balanceOf: sel("balanceOf", ["address"]), isPerson: sel("isPerson", ["address"]), isEntity: sel("isEntity", ["address"]),
  signaledCounter: sel("signaledCounter", ["address"]), currentRoundId: sel("currentRoundId", []), roundSnapshot: sel("roundSnapshot", ["uint256"]),
  hasVoted: sel("hasVoted", ["uint256", "address"]), getSelectedTokenIdAtBlock: sel("getSelectedTokenIdAtBlock", ["address", "uint48"]),
  hasTokenVoted: sel("hasTokenVoted", ["uint256", "uint256"]), ownerOf: sel("ownerOf", ["uint256"]), levelOf: sel("levelOf", ["uint256"]),
};
const words = (data) => (data.slice(10).match(/.{64}/g) || []);
const byteOf = (w) => w.slice(-2);
function member(data) {
  const s = data.slice(0, 10), a = words(data);
  const who = a[0] ? byteOf(a[0]) : "";
  const gm = who !== "c5";
  if (s === S.balanceOf) return word(gm ? 1 : 0);
  if (s === S.isPerson) return word(1) + word(64) + word(5) + Buffer.from("human").toString("hex").padEnd(64, "0");
  if (s === S.isEntity || s === S.signaledCounter) return word(0);
  if (s === S.currentRoundId) return word(50);
  if (s === S.roundSnapshot) return word(1000);
  if (s === S.hasVoted) return word(1);
  if (s === S.getSelectedTokenIdAtBlock) return word(gm ? parseInt(who, 16) : 0);
  if (s === S.hasTokenVoted) return word(1);
  if (s === S.ownerOf) { const b = BigInt("0x" + a[0]).toString(16).padStart(2, "0"); return "0".repeat(24) + b.repeat(20); }
  if (s === S.levelOf) return word(2);
  return null;
}
const resets = {
  [KYC]: [{ origin: KYC_RESETTER, reason: KYC_REASON, txID: "0x" + "71".repeat(32) }],
  [OTHER_ORIGIN]: [{ origin: "0x" + "99".repeat(20), reason: KYC_REASON, txID: "0x" + "72".repeat(32) }],
  [OTHER_REASON]: [{ origin: KYC_RESETTER, reason: "Resetting after appeal", txID: "0x" + "73".repeat(32) }],
  [KYC_NO_GM]: [{ origin: KYC_RESETTER, reason: KYC_REASON, txID: "0x" + "75".repeat(32) }],
};

function fakeChain() {
  const f = { asked: [] };
  f.srv = createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url.startsWith("/logs/event")) {
        const c = JSON.parse(b || "{}").criteriaSet?.[0] || {};
        f.asked.push(c);
        if (String(c.address).toLowerCase() !== PASSPORT || c.topic0 !== TOPIC) return res.end("[]");
        const who = "0x" + String(c.topic1 || "").slice(-40);
        return res.end(JSON.stringify((resets[who] || []).map((r) => ({
          address: PASSPORT, topics: [TOPIC, c.topic1], data: str(r.reason),
          meta: { txOrigin: r.origin, txID: r.txID, blockTimestamp: 1763400000 },
        }))));
      }
      if (req.url.startsWith("/blocks/")) return res.end(JSON.stringify({ id: "0x" + "00".repeat(32), number: 1, timestamp: Math.floor(Date.now() / 1000), gasLimit: 1 }));
      if (req.method === "POST" && req.url.startsWith("/accounts/")) {
        const data = String(JSON.parse(b || "{}").data || "");
        const out = member(data);
        return res.end(JSON.stringify({ data: out ? "0x" + out : "0x", events: [], transfers: [], gasUsed: 0, reverted: false, vmError: "" }));
      }
      res.end("null");
    });
  });
  return new Promise((r) => f.srv.listen(0, "127.0.0.1", () => { f.url = `http://127.0.0.1:${f.srv.address().port}`; r(f); }));
}

describe("a KYC reset by the Foundation: allowed in, shown to the admin", () => {
  let srv, chain, admin;
  before(async () => {
    chain = await fakeChain();
    admin = await adminSigner();
    srv = await startServer({ state: { settings: { access: "gm" } }, env: { NODE_URL: chain.url, ADMIN_WALLETS: admin.address } });
  });
  after(async () => { await srv.stop(); chain.srv.close(); });

  const seen = (address) => fetch(srv.base + "/wallet/seen", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": `10.9.0.${parseInt(address.slice(2, 4), 16)}` }, body: JSON.stringify({ address }) });
  const flagged = (s, a) => Object.keys(s.flags || {}).includes(`kyc-reset:${a}`);

  test("the Foundation's KYC reset: flagged once the wallet connects", async () => {
    await seen(KYC);
    const st = await srv.waitForState((s) => flagged(s, KYC), 4000);
    assert.ok(flagged(st, KYC));
    assert.match(st.flags[`kyc-reset:${KYC}`].reason, /reset by the VeBetterDAO Foundation after KYC/);
    assert.match(st.flags[`kyc-reset:${KYC}`].reason, /0x7171/);
    const c = chain.asked.find((x) => x.topic1?.endsWith(KYC.slice(2)));
    assert.equal(c.topic0, TOPIC, "asks for UserSignalsReset");
    assert.equal(String(c.address).toLowerCase(), PASSPORT, "on VeBetterPassport");
  });

  test("a KYC reset on a wallet that isn't let in: not flagged \"allowed in\"", async () => {
    const r = await (await seen(KYC_NO_GM)).json();
    assert.equal(r.hasPass, false);
    await new Promise((x) => setTimeout(x, 800));
    assert.equal(flagged(srv.readState(), KYC_NO_GM), false);
  });

  test("the same reason from another wallet, or another reason from the Foundation: not flagged", async () => {
    await seen(OTHER_ORIGIN); await seen(OTHER_REASON); await seen(PLAIN);
    await new Promise((r) => setTimeout(r, 800));
    const st = srv.readState();
    assert.equal(flagged(st, OTHER_ORIGIN), false);
    assert.equal(flagged(st, OTHER_REASON), false);
    assert.equal(flagged(st, PLAIN), false);
  });

  test("the admin's lookup says so", async () => {
    let r = await admin.call(srv, "/admin/lookup", { targetWallet: KYC });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.kycReset.reset, true);
    assert.equal(r.body.kycReset.txid, "0x" + "71".repeat(32));
    r = await admin.call(srv, "/admin/lookup", { targetWallet: OTHER_ORIGIN });
    assert.equal(r.body.kycReset.reset, false);
  });
});
