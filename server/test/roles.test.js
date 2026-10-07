// ── Who may use this version ─────────────────────────────────────────────────
// Each server (mainnet, the test copy) has its own list of wallets with a role.
// "roles": only those wallets — and the admins — get in. "everyone": anyone. The
// admin flips it with a signed request; it survives a restart.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { Certificate, Secp256k1, Address } from "@vechain/sdk-core";
import { startServer, photo, stateWithBaseline, WALLET } from "./helpers.mjs";

let ADMIN_PRIV, ADMIN;
async function adminCert(path, body) {
  const extra = { ...body };
  const content = `Green Utility Log — admin\nAction: ${path}|${JSON.stringify(extra, Object.keys(extra).sort())}\nTime: ${new Date().toISOString()}`;
  const base = { purpose: "identification", payload: { type: "text", content }, domain: "test.local", timestamp: Math.floor(Date.now() / 1000), signer: ADMIN };
  const c = Certificate.of(base); c.sign(ADMIN_PRIV);
  const signature = typeof c.signature === "string" ? c.signature : Buffer.from(c.signature).toString("hex");
  return { ...base, signature };
}
const admin = async (srv, path, body) => srv.post(path, { ...body, address: ADMIN, certificate: await adminCert(path, body) });
const submit = (srv, address, tag) => srv.post("/reward", {
  utility: "electric", meterNo: "E1000", address, reading: 1008, prevRead: 1000, photo: photo(tag), photoMime: "image/jpeg",
});

describe("access per version", () => {
  let srv;
  before(async () => {
    ADMIN_PRIV = await Secp256k1.generatePrivateKey();
    ADMIN = Address.ofPrivateKey(ADMIN_PRIV).toString();
    srv = await startServer({
      // passesInit: 1 — the one-time grandfathering has already run, so WALLET has no pass.
      state: stateWithBaseline(),
      env: { REQUIRE_PASS: "true", PASSPORT_GRANTS_ACCESS: "false", ADMIN_WALLETS: ADMIN.toLowerCase(), COOLDOWN_MS: "0" },
    });
  });
  after(async () => { await srv.stop(); });

  test("starts closed: a wallet without a role is told so, and isn't paid", async () => {
    const seen = await srv.post("/wallet/seen", { address: WALLET });
    assert.equal(seen.body.access, "roles");
    assert.equal(seen.body.hasPass, false);
    assert.equal(seen.body.isAdmin, false);
    const r = await submit(srv, WALLET, "closed");
    assert.equal(r.status, 403);
    assert.equal(r.body.needsPass, true);
  });

  test("an admin is always let in, and told it is an admin", async () => {
    const seen = await srv.post("/wallet/seen", { address: ADMIN });
    assert.equal(seen.body.isAdmin, true);
    assert.equal(seen.body.hasPass, true);
  });

  test("a role must be one of tester or user", async () => {
    const bad = await admin(srv, "/admin/pass", { targetWallet: WALLET, tier: "boss" });
    assert.equal(bad.status, 400);
    const ok = await admin(srv, "/admin/pass", { targetWallet: WALLET, tier: "tester" });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.pass.tier, "tester");
    const seen = await srv.post("/wallet/seen", { address: WALLET });
    assert.equal(seen.body.hasPass, true);
  });

  test("the role can be changed and keeps its number", async () => {
    const before = (await admin(srv, "/admin/passes", {})).body.passes.find((p) => p.address === WALLET.toLowerCase());
    const r = await admin(srv, "/admin/pass", { targetWallet: WALLET, tier: "user" });
    assert.equal(r.body.pass.tier, "user");
    assert.equal(r.body.pass.no, before.no);
  });

  test("withdrawn again, then the admin opens the version to everyone", async () => {
    await admin(srv, "/admin/pass", { targetWallet: WALLET, grant: false });
    assert.equal((await srv.post("/wallet/seen", { address: WALLET })).body.hasPass, false);
    const r = await admin(srv, "/admin/access", { mode: "everyone" });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const seen = await srv.post("/wallet/seen", { address: WALLET });
    assert.equal(seen.body.access, "everyone");
    assert.equal(seen.body.hasPass, true);
    const pay = await submit(srv, WALLET, "open");
    assert.equal(pay.status, 200, JSON.stringify(pay.body));
    assert.equal((await srv.get("/health")).body.access, "everyone");
  });

  test("only an admin can flip it, and only to a known mode", async () => {
    const notAdmin = await srv.post("/admin/access", { mode: "roles", address: WALLET });
    assert.equal(notAdmin.status, 403);
    const bad = await admin(srv, "/admin/access", { mode: "nobody" });
    assert.equal(bad.status, 400);
  });

  test("the switch is saved with the server's state", async () => {
    const r = await admin(srv, "/admin/access", { mode: "roles" });
    assert.equal(r.body.access, "roles");
    const st = await srv.waitForState((s) => s.settings?.access === "roles");
    assert.equal(st.settings.access, "roles");
  });
});
