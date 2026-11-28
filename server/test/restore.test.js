// ── A phone that lost its setup gets it back with one signature ──────────────
// 28 November, go-live: the owner's mainnet app on the same phone started from
// nothing, while the server had carried the meter, its starting point and the
// reader over. /wallet/restore brings them back to the wallet that signs, and to
// nobody else.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { startServer } from "./helpers.mjs";

const require = createRequire(import.meta.url);
const { Certificate, Secp256k1, Address } = require("@vechain/sdk-core");
async function wallet() {
  const priv = await Secp256k1.generatePrivateKey();
  return { priv, address: Address.ofPrivateKey(priv).toString().toLowerCase() };
}
function cert(w, content) {
  const base = { purpose: "identification", payload: { type: "text", content }, domain: "test.local", timestamp: Math.floor(Date.now() / 1000), signer: w.address };
  const c = Certificate.of(base); c.sign(w.priv);
  return { ...base, signature: typeof c.signature === "string" ? c.signature : Buffer.from(c.signature).toString("hex") };
}
const RESTORE = (w) => `Green Utility Log — restore my setup\nWallet: ${w.address}\nNetwork: testnet\nTime: ${new Date().toISOString()}`;
const TOKEN = "c".repeat(48);

describe("restoring a wallet's setup", () => {
  let srv, owner, other, empty;
  before(async () => {
    [owner, other, empty] = await Promise.all([wallet(), wallet(), wallet()]);
    srv = await startServer({
      env: { REQUIRE_CERT: "true" },
      state: {
        meterOwners: { "electric:e0051004380886718": owner.address },
        readings: { "electric:e0051004380886718": 7884.391 },
        readingAts: { "electric:e0051004380886718": Date.now() - 8 * 3600e3 },
        meterLinks: { [TOKEN]: { address: owner.address, meterNo: "e0051004380886718", utility: "electric", source: "bridge", createdAt: Date.now() - 86400000 } },
      },
    });
  });
  after(async () => { await srv.stop(); });
  const restore = (body) => srv.post("/wallet/restore", body);

  // The link stores the number lower-case here, as a carried-over or re-paired one can.
  test("the owner's signature: meter, starting point and reader token come back", async () => {
    const r = await restore({ address: owner.address, certificate: cert(owner, RESTORE(owner)) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.meters, [{ utility: "electric", meterNo: "E0051004380886718", last: 7884.391 }]);
    assert.deepEqual(r.body.reader, { token: TOKEN, meterNo: "E0051004380886718", utility: "electric" });
  });

  test("the same signature again: refused (single use)", async () => {
    const c = cert(owner, RESTORE(owner));
    assert.equal((await restore({ address: owner.address, certificate: c })).status, 200);
    const again = await restore({ address: owner.address, certificate: c });
    assert.equal(again.status, 401);
    assert.equal(again.body.token, undefined);
  });

  test("another wallet's signature for the owner's address: nothing", async () => {
    const r = await restore({ address: owner.address, certificate: cert(other, RESTORE(owner)) });
    assert.equal(r.status, 401);
    assert.equal(r.body.reader, undefined);
    assert.equal(r.body.meters, undefined);
  });

  test("a signature made for something else (linking a meter): nothing", async () => {
    const r = await restore({ address: owner.address, certificate: cert(owner, `Green Utility Log — link smart meter\nWallet: ${owner.address}\nNetwork: testnet`) });
    assert.equal(r.status, 401);
    assert.equal(r.body.reader, undefined);
  });

  test("no signature at all: nothing", async () => {
    const r = await restore({ address: owner.address });
    assert.equal(r.status, 401);
    assert.equal(r.body.meters, undefined);
  });

  test("a wallet with nothing on the server: an empty answer, and its signature isn't spent", async () => {
    const before = Object.keys(srv.readState().usedCerts || {}).length;
    const r = await restore({ address: empty.address, certificate: cert(empty, RESTORE(empty)) });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body, { ok: true, meters: [], reader: null });
    await new Promise((res) => setTimeout(res, 400));
    assert.equal(Object.keys(srv.readState().usedCerts || {}).length, before, "nothing stored for it");
  });
});

test("a restore signed for the other network is refused", async () => {
  const w = await wallet();
  const srv = await startServer({ env: { REQUIRE_CERT: "true" }, state: { meterOwners: { "electric:x1": w.address }, readings: { "electric:x1": 5 } } });
  try {
    const r = await srv.post("/wallet/restore", { address: w.address, certificate: cert(w, `Green Utility Log — restore my setup\nWallet: ${w.address}\nNetwork: mainnet\nTime: ${new Date().toISOString()}`) });
    assert.equal(r.status, 401);
    assert.equal(r.body.meters, undefined);
  } finally { await srv.stop(); }
});
