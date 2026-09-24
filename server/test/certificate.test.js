// ── What a wallet signature actually authorises ──────────────────────────────
// A signature proves who is asking. Binding it to what was asked, and spending it
// once, is what stops a captured certificate being presented for a different
// submission or for the same one twice — inside the fifteen minutes it stays
// fresh. The admin endpoints have always done both; the ones that move B3TR did
// neither, so these run with REQUIRE_CERT on and real signatures.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Certificate, Secp256k1, Address } from "@vechain/sdk-core";
import { startServer, photo, stateWithBaseline } from "./helpers.mjs";

const METER = "E1000";

let PRIV, WALLET;
async function sign(content) {
  if (!PRIV) {
    PRIV = await Secp256k1.generatePrivateKey();
    WALLET = Address.ofPrivateKey(PRIV).toString();
  }
  const base = {
    purpose: "identification",
    payload: { type: "text", content },
    domain: "test.local",
    timestamp: Math.floor(Date.now() / 1000),
    signer: WALLET,
  };
  const c = Certificate.of(base);
  c.sign(PRIV);
  const signature = typeof c.signature === "string"
    ? c.signature : Buffer.from(c.signature).toString("hex");
  return { ...base, signature };
}

const submissionText = (utility, reading) =>
  `Green Utility Log — confirm submission\nWallet: ${WALLET}\nUtility: ${utility}\nReading: ${reading}\nTime: ${new Date().toISOString()}`;

describe("a signature on a real submission", () => {
  let srv;
  before(async () => {
    await sign("warm up the key");
    srv = await startServer({
      state: stateWithBaseline({ wallet: WALLET }),
      env: { REQUIRE_CERT: "true", COOLDOWN_MS: "0" },
    });
  });
  after(async () => { await srv.stop(); });

  const body = (over = {}) => ({
    utility: "electric", meterNo: METER, address: WALLET,
    reading: 1008, prevRead: 1000, photo: photo("cert"), photoMime: "image/jpeg",
    ...over,
  });

  test("is accepted when it matches the submission", async () => {
    const certificate = await sign(submissionText("electric", 1008));
    const r = await srv.post("/reward", body({ certificate }));
    assert.equal(r.status, 200, JSON.stringify(r.body));
  });

  test("cannot be presented a second time", async () => {
    const certificate = await sign(submissionText("electric", 1016));
    const first = await srv.post("/reward", body({ certificate, reading: 1016 }));
    assert.equal(first.status, 200, JSON.stringify(first.body));

    // The SAME reading again, with a fresh photo. Zero usage is explicitly valid
    // and the content still matches, so the only thing left to refuse it is the
    // signature having been spent.
    const again = await srv.post("/reward", body({ certificate, reading: 1016 }));
    assert.equal(again.status, 401);
    assert.match(again.body.error, /already used/i);
  });

  test("cannot be moved to a different reading", async () => {
    const certificate = await sign(submissionText("electric", 1032));
    const r = await srv.post("/reward", body({ certificate, reading: 1040 }));
    assert.equal(r.status, 401);
    assert.match(r.body.error, /does not authorise/i);
  });

  test("cannot be moved to a different utility", async () => {
    const certificate = await sign(submissionText("gas", 1032));
    const r = await srv.post("/reward", body({ certificate, reading: 1032 }));
    assert.equal(r.status, 401);
    assert.match(r.body.error, /does not authorise/i);
  });

  test("cannot be spent on a different endpoint", async () => {
    // A signature made to submit a meter reading must not settle an automatic one.
    const certificate = await sign(submissionText("electric", 1032));
    const r = await srv.post("/reward-from-meter", { address: WALLET, meterNo: METER, certificate });
    assert.equal(r.status, 401);
    assert.match(r.body.error, /does not authorise/i);
  });

  test("is refused outright when it is missing", async () => {
    const r = await srv.post("/reward", body({ reading: 1032 }));
    assert.equal(r.status, 401);
    assert.match(r.body.error, /wallet signature \(certificate\) is required/i);
  });

  test("is refused when someone else signed it", async () => {
    const otherPriv = await Secp256k1.generatePrivateKey();
    const otherAddr = Address.ofPrivateKey(otherPriv).toString();
    const base = {
      purpose: "identification",
      payload: { type: "text", content: submissionText("electric", 1032) },
      domain: "test.local", timestamp: Math.floor(Date.now() / 1000), signer: otherAddr,
    };
    const c = Certificate.of(base); c.sign(otherPriv);
    const signature = typeof c.signature === "string" ? c.signature : Buffer.from(c.signature).toString("hex");
    const r = await srv.post("/reward", body({ certificate: { ...base, signature }, reading: 1032 }));
    assert.equal(r.status, 401);
    assert.match(r.body.error, /signer does not match/i);
  });

  test("is refused when it has gone stale", async () => {
    const content = submissionText("electric", 1032);
    const base = {
      purpose: "identification", payload: { type: "text", content }, domain: "test.local",
      timestamp: Math.floor(Date.now() / 1000) - 3600,   // an hour old
      signer: WALLET,
    };
    const c = Certificate.of(base); c.sign(PRIV);
    const signature = typeof c.signature === "string" ? c.signature : Buffer.from(c.signature).toString("hex");
    const r = await srv.post("/reward", body({ certificate: { ...base, signature }, reading: 1032 }));
    assert.equal(r.status, 401);
    assert.match(r.body.error, /expired/i);
  });

  test("is refused when the payload was edited after signing", async () => {
    // A plausible reading on purpose: structural validation runs before the
    // signature is checked, so an implausible one would be refused for the wrong
    // reason and the test would prove nothing about tampering.
    const certificate = await sign(submissionText("electric", 1032));
    certificate.payload = { type: "text", content: submissionText("electric", 1040) };
    const r = await srv.post("/reward", body({ certificate, reading: 1040 }));
    assert.equal(r.status, 401);
    assert.match(r.body.error, /signature is invalid/i);
  });
});

describe("a signature re-spelled to look new", () => {
  let srv;
  before(async () => {
    await sign("warm up the key");
    srv = await startServer({
      state: stateWithBaseline({ wallet: WALLET }),
      env: { REQUIRE_CERT: "true" },
    });
  });
  after(async () => { await srv.stop(); });

  test("is still the same signature, and is refused the second time", async () => {
    // The same signature verifies in upper case too. Spent-ness used to be keyed on
    // the raw text, so re-spelling it passed as unused.
    const cert = await sign(`Green Utility Log — link smart meter\nWallet: ${WALLET}\nTime: ${new Date().toISOString()}`);
    const first = await srv.post("/meter/pair", { address: WALLET, meterNo: METER, certificate: cert });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    const respelled = { ...cert, signature: "0x" + cert.signature.replace(/^0x/, "").toUpperCase() };
    const again = await srv.post("/meter/pair", { address: WALLET, meterNo: METER, certificate: respelled });
    assert.equal(again.status, 401);
    assert.match(again.body.error, /already used/i);
  });

  test("a signature made for something else cannot link a meter", async () => {
    const cert = await sign("Some other dApp — log in");
    const r = await srv.post("/meter/pair", { address: WALLET, meterNo: METER, certificate: cert });
    assert.equal(r.status, 401);
  });
});
