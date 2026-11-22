// ── A certificate is spent only on a request that does something ─────────────
// Each spent certificate is stored for half an hour. /meter/unpair, the cloud
// unlinks and /meter/pair spent one before checking there was anything to do or
// that the wallet may earn, so throwaway wallets (free to make) could grow that
// store at will. Now: nothing to delete → nothing spent; no access → nothing
// spent; and the store has a ceiling.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const { Certificate, Secp256k1, Address } = require("@vechain/sdk-core");
async function selfCert(content) {
  const priv = await Secp256k1.generatePrivateKey();
  const address = Address.ofPrivateKey(priv).toString();
  const base = { purpose: "identification", payload: { type: "text", content }, domain: "test.local", timestamp: Math.floor(Date.now() / 1000), signer: address };
  const c = Certificate.of(base); c.sign(priv);
  const signature = typeof c.signature === "string" ? c.signature : Buffer.from(c.signature).toString("hex");
  return { address, certificate: { ...base, signature } };
}
const used = (srv) => Object.keys(JSON.parse(JSON.stringify(srv.readState().usedCerts || {}))).length;

describe("throwaway wallets", () => {
  let srv;
  // Roles mode: a wallet without a role may not pair.
  before(async () => { srv = await startServer({ state: { settings: { access: "roles" } }, env: { REQUIRE_CERT: "true", REQUIRE_PASS: "true", USED_CERTS_MAX: "3" } }); });
  after(async () => { await srv.stop(); });
  const post = (p, b, i) => fetch(srv.base + p, { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": `10.3.0.${i}` }, body: JSON.stringify(b) });

  test("unpair / unlink with nothing stored: answered, no certificate spent", async () => {
    for (let i = 0; i < 4; i++) {
      const { address, certificate } = await selfCert("Green Utility Log — link smart meter\nNetwork: testnet");
      const r = await post("/meter/unpair", { address, certificate }, i);
      assert.equal(r.status, 200);
      assert.equal((await r.json()).unpaired, false);
      const u = await selfCert("Green Utility Log — unlink Tibber\nNetwork: testnet");
      assert.equal((await post("/meter/tibber/unlink", { address: u.address, certificate: u.certificate }, i)).status, 200);
    }
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(used(srv), 0);
  });

  test("pairing without access: refused, no certificate spent", async () => {
    const { address, certificate } = await selfCert("Green Utility Log — link smart meter\nNetwork: testnet");
    const r = await post("/meter/pair", { address, certificate, meterNo: "X1" }, 9);
    assert.equal(r.status, 403);
    assert.equal((await r.json()).needsPass, true);
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(used(srv), 0);
  });
});

describe("the spent-certificate store has a ceiling", () => {
  let srv;
  before(async () => { srv = await startServer({ state: { settings: { access: "everyone" } }, env: { REQUIRE_CERT: "true", USED_CERTS_MAX: "3" } }); });
  after(async () => { await srv.stop(); });
  test("past the ceiling: 'try again', the store doesn't grow", async () => {
    const codes = [];
    for (let i = 0; i < 5; i++) {
      const { address, certificate } = await selfCert("Green Utility Log — link smart meter\nNetwork: testnet");
      const r = await fetch(srv.base + "/meter/pair", { method: "POST", headers: { "Content-Type": "application/json", "CF-Connecting-IP": `10.4.0.${i}` }, body: JSON.stringify({ address, certificate, meterNo: `Y${i}` }) });
      codes.push(r.status);
    }
    assert.deepEqual(codes, [200, 200, 200, 503, 503]);
    const st = await srv.waitForState((x) => Object.keys(x.usedCerts || {}).length >= 3, 4000);
    assert.equal(Object.keys(st.usedCerts || {}).length, 3);
  });
});
