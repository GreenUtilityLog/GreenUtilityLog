// ── Access mode "gm": a VeBetterDAO GM NFT and a Passport that counts you ────────
// The owner's rule for mainnet: only wallets with a Galaxy Member NFT (any level)
// AND a VeBetterDAO Passport that counts them as a person may use the app. Checked
// by the server on chain (at connect and at every payout), not only in the app.
// Admins always get in; a role gives no access in this mode.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { ABIFunction } from "@vechain/sdk-core";
import { startServer, fakeNode, adminSigner, photo } from "./helpers.mjs";
import { defaultAccess } from "../config.js";

const GM = "0x38a59fa7fd7039884465a0ff285b8c4b6fe394ca";        // testnet GalaxyMember
const PASSPORT = "0x592c756df7a5d39de1735030e8b9c18b7417e6c4";  // testnet VeBetterPassport
const sel = (name, inputs) => new ABIFunction({ name, type: "function", stateMutability: "view", inputs, outputs: [] }).signatureHash.slice(0, 10);
const BALANCE_OF = sel("balanceOf", [{ name: "o", type: "address" }]);
const IS_PERSON = sel("isPerson", [{ name: "u", type: "address" }]);
const word = (n) => BigInt(n).toString(16).padStart(64, "0");
const boolAndString = (b, str) => {
  const s = Buffer.from(str, "utf8");
  return "0x" + word(b ? 1 : 0) + word(64) + word(s.length) + s.toString("hex").padEnd(Math.max(64, Math.ceil(s.length / 32) * 64), "0");
};

const FULL     = "0x" + "a1".repeat(20);  // GM NFT + Passport person
const GM_ONLY  = "0x" + "a2".repeat(20);  // GM NFT, Passport says no
const NONE     = "0x" + "a3".repeat(20);  // no GM NFT
const TESTER   = "0x" + "a4".repeat(20);  // a role, but no GM NFT
const UNREAD   = "0x" + "a5".repeat(20);  // the node gives no answer for this one
const PP_UNREAD = "0x" + "a6".repeat(20); // a GM NFT; the Passport can't be read
const owners = { [FULL]: 1, [GM_ONLY]: 2, [NONE]: 0, [TESTER]: 0, [PP_UNREAD]: 1 };
const persons = { [FULL]: [true, "User is a Galaxy Member"], [GM_ONLY]: [false, "User has been signaled too many times"] };

function onCall(to, data) {
  const who = "0x" + data.slice(-40);
  if (to === GM && data.startsWith(BALANCE_OF)) return who in owners ? "0x" + word(owners[who]) : null;
  if (to === PASSPORT && data.startsWith(IS_PERSON)) {
    if (who === PP_UNREAD) return null; // no answer
    const p = persons[who]; return p ? boolAndString(p[0], p[1]) : boolAndString(false, "");
  }
  return null;
}

test("mainnet starts on gm, testnet as REQUIRE_PASS says", () => {
  assert.equal(defaultAccess("mainnet", true), "gm");
  assert.equal(defaultAccess("mainnet", false), "gm");
  assert.equal(defaultAccess("testnet", true), "roles");
  assert.equal(defaultAccess("testnet", false), "everyone");
});

describe("access mode gm", () => {
  let srv, node, admin;
  const seen = (address) => srv.post("/wallet/seen", { address });
  before(async () => {
    node = await fakeNode("ok", { onCall });
    admin = await adminSigner();
    srv = await startServer({
      state: { settings: { access: "gm" }, passes: { [TESTER]: { no: 1, issuedAt: Date.now(), issuedBy: null, tier: "tester", note: "" } }, passSeq: 1, passesInit: 1 },
      env: { NODE_URL: node.url, ADMIN_WALLETS: admin.address },
    });
  });
  after(async () => { await srv.stop(); node.srv.close(); });

  test("a GM NFT and a Passport person: in", async () => {
    const r = await seen(FULL);
    assert.equal(r.body.access, "gm");
    assert.equal(r.body.hasPass, true);
  });

  test("a GM NFT but no Passport person: out, and told why", async () => {
    const r = await seen(GM_ONLY);
    assert.equal(r.body.hasPass, false);
    assert.deepEqual(r.body.gmAccess, { gm: true, person: false });
    const pay = await srv.post("/reward", { utility: "electric", meterNo: "E1", address: GM_ONLY, reading: 1, photo: photo("gm-only") });
    assert.equal(pay.status, 403);
    assert.equal(pay.body.needsPass, true);
    assert.match(pay.body.error, /Passport doesn't count it as a person/);
  });

  test("no GM NFT: out, and told what is needed (in the app's language)", async () => {
    const r = await seen(NONE);
    assert.equal(r.body.hasPass, false);
    assert.deepEqual(r.body.gmAccess, { gm: false, person: null });
    const pay = await fetch(srv.base + "/reward", { method: "POST", headers: { "Content-Type": "application/json", "X-GUL-Lang": "nl" },
      body: JSON.stringify({ utility: "electric", meterNo: "E1", address: NONE, reading: 1, photo: photo("none") }) });
    const body = await pay.json();
    assert.equal(pay.status, 403);
    assert.match(body.error, /voor leden van VeBetterDAO/);
    assert.match(body.errorEn, /Galaxy Member \(GM\) NFT and a VeBetterDAO Passport/);
  });

  test("a role without a GM NFT gives no access in this mode", async () => {
    assert.equal((await seen(TESTER)).body.hasPass, false);
  });

  test("the chain can't be read: out for now, and says so", async () => {
    const r = await seen(UNREAD);
    assert.equal(r.body.hasPass, false);
    assert.equal(r.body.gmAccess.gm, null);
    const pay = await srv.post("/reward", { utility: "electric", meterNo: "E1", address: UNREAD, reading: 1, photo: photo("unread") });
    assert.equal(pay.status, 403);
    assert.match(pay.body.error, /couldn't check this wallet's VeBetterDAO GM NFT/);
  });

  test("the Passport can't be read: out for now, told to try again (not that it doesn't count)", async () => {
    const r = await seen(PP_UNREAD);
    assert.equal(r.body.hasPass, false);
    assert.deepEqual(r.body.gmAccess, { gm: true, person: null });
    const pay = await srv.post("/reward", { utility: "electric", meterNo: "E1", address: PP_UNREAD, reading: 1, photo: photo("pp-unread") });
    assert.equal(pay.status, 403);
    assert.match(pay.body.error, /couldn't check this wallet's VeBetterDAO Passport/);
  });

  test("the payout gate lets the full wallet through (it fails later, on the photo, not on access)", async () => {
    const pay = await srv.post("/reward", { utility: "electric", meterNo: "E1", address: FULL, reading: 1, photo: "x" });
    assert.notEqual(pay.body.needsPass, true, JSON.stringify(pay.body));
  });

  test("the admin always gets in, without a GM NFT", async () => {
    assert.equal((await seen(admin.address)).body.hasPass, true);
  });

  test("an admin can switch between gm, roles and everyone", async () => {
    let r = await admin.call(srv, "/admin/access", { mode: "roles" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal((await seen(TESTER)).body.hasPass, true, "in roles mode the role counts again");
    r = await admin.call(srv, "/admin/access", { mode: "gm" });
    assert.equal(r.body.access, "gm");
    assert.equal((await seen(TESTER)).body.hasPass, false);
    r = await admin.call(srv, "/admin/access", { mode: "nonsense" });
    assert.equal(r.status, 400);
  });
});
