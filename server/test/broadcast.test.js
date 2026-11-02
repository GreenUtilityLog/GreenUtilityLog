// ── A broadcast whose reply is lost must not be paid again ───────────────────
// reward.js signs first and broadcasts second, so when the broadcast call fails
// it can ask the node whether the transaction arrived anyway. A fake node stands
// in for VeChain: it can take the transaction and drop the reply, or refuse it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { fakeNode } from "./helpers.mjs";

const SERVER_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");

async function send(mode) {
  const node = await fakeNode(mode);
  const script = `
    const { sendClauseTo } = await import("./reward.js");
    const abi = { name: "claim", type: "function", stateMutability: "nonpayable", inputs: [], outputs: [] };
    try { const r = await sendClauseTo("0x${"3".repeat(40)}", abi, [], "test"); console.log("RESULT " + JSON.stringify(r)); }
    catch (e) { console.log("THREW " + e.message.split("\\n")[0]); }
    process.exit(0);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: SERVER_DIR,
    env: { ...process.env, BROADCAST_RETRY_MS: "50", NODE_URL: node.url, DISTRIBUTOR_PRIVATE_KEY: randomBytes(32).toString("hex"), DISTRIBUTOR_DRY_RUN: "", NETWORK: "testnet" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
  await new Promise((r) => child.on("exit", r));
  node.srv.close();
  return { out, received: node.seen.size > 0, raws: node.raws };
}

test("the node took it but the reply was lost: counted as sent, not retried", async () => {
  const r = await send("lost-reply");
  assert.ok(r.received);
  assert.match(r.out, /RESULT \{"txid":"0x[0-9a-f]{64}"/, r.out);
});

test("the node refused it: reported as not sent, so the claim can be retried", async () => {
  const r = await send("refused");
  assert.ok(!r.received);
  assert.match(r.out, /THREW/, r.out);
});

test("a broadcast that failed is sent again as is: one transaction, one id", async () => {
  const r = await send("flaky");
  assert.match(r.out, /RESULT \{"txid":"0x[0-9a-f]{64}","reverted":false\}/, r.out);
  assert.equal(r.raws.length, 1, "the node took exactly one transaction");
});

test("a normal broadcast", async () => {
  const r = await send("ok");
  assert.match(r.out, /RESULT \{"txid":"0x[0-9a-f]{64}","reverted":false\}/, r.out);
});

import { ABIFunction, Transaction, HexUInt } from "@vechain/sdk-core";

test("a pool without the metadata variant still gets proof and impact", async () => {
  const sel = (abi) => new ABIFunction(abi).encodeData(abi.inputs.map((i) => (i.type.endsWith("[]") ? [] : i.type === "address" ? "0x" + "1".repeat(40) : i.type === "bytes32" ? "0x" + "0".repeat(64) : i.type === "string" ? "" : 0))).toString().slice(0, 10);
  const str = (n) => ({ name: n, type: "string" }), arr = (n, t) => ({ name: n, type: t + "[]" });
  const withMeta = { name: "distributeRewardWithProofAndMetadata", type: "function", stateMutability: "nonpayable", outputs: [], inputs: [{ name: "appId", type: "bytes32" }, { name: "amount", type: "uint256" }, { name: "receiver", type: "address" }, arr("proofTypes", "string"), arr("proofValues", "string"), arr("impactCodes", "string"), arr("impactValues", "uint256"), str("description"), str("metadata")] };
  const withProof = { ...withMeta, name: "distributeRewardWithProof", inputs: withMeta.inputs.slice(0, 8) };
  const node = await fakeNode("ok", { revertSelector: sel(withMeta) });
  const script = `
    const { distributeReward } = await import("./reward.js");
    try { const tx = await distributeReward({ utility: "electric", meterNo: "E1\\"x", reading: 1008, prevRead: 1000, usage: 3, amount: 1, receiver: "0x${"4".repeat(40)}", source: "photo" }); console.log("TX " + tx); }
    catch (e) { console.log("THREW " + e.message); }
    process.exit(0);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: SERVER_DIR,
    env: { ...process.env, BROADCAST_RETRY_MS: "50", NODE_URL: node.url, DISTRIBUTOR_PRIVATE_KEY: randomBytes(32).toString("hex"), DISTRIBUTOR_DRY_RUN: "", NETWORK: "testnet" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
  await new Promise((r) => child.on("exit", r));
  node.srv.close();
  assert.match(out, /TX 0x/, out);
  const tx = Transaction.decode(HexUInt.of(node.raws[0].replace(/^0x/, "")).bytes, true);
  const data = tx.body.clauses[0].data;
  assert.ok(data.startsWith(sel(withProof)), "sent distributeRewardWithProof");
  const decoded = new ABIFunction(withProof).decodeData(data);
  const args = Array.isArray(decoded) ? decoded : decoded.args || Object.values(decoded);
  const flat = JSON.stringify(args, (k, v) => (typeof v === "bigint" ? v.toString() : v));
  assert.match(flat, /electric reading 1008 \(previous 1000\), meter E1x/, "meter text stripped of the quote and backslash");
  assert.match(flat, /"carbon"/, "and impact is there");
});

test("sent but not yet in a block: reported as pending, not as paid", async () => {
  const node = await fakeNode("no-receipt");
  const script = `
    const { sendClauseTo, payoutPending } = await import("./reward.js");
    const abi = { name: "claim", type: "function", stateMutability: "nonpayable", inputs: [], outputs: [] };
    const r = await sendClauseTo("0x${"3".repeat(40)}", abi, [], "test");
    console.log("PENDING " + payoutPending(r.txid));
    process.exit(0);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: SERVER_DIR,
    env: { ...process.env, RECEIPT_WAIT_MS: "300", BROADCAST_RETRY_MS: "50", NODE_URL: node.url, DISTRIBUTOR_PRIVATE_KEY: randomBytes(32).toString("hex"), DISTRIBUTOR_DRY_RUN: "", NETWORK: "testnet" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
  await new Promise((r) => child.on("exit", r));
  node.srv.close();
  assert.match(out, /PENDING true/, out);   // the fake node never returns a receipt
});

async function recheck(mode) {
  const node = await fakeNode(mode);
  const script = `
    const { sendClauseTo, payoutPending, recheckPendingPayouts } = await import("./reward.js");
    const abi = { name: "claim", type: "function", stateMutability: "nonpayable", inputs: [], outputs: [] };
    const r = await sendClauseTo("0x${"3".repeat(40)}", abi, [], "test");
    const lost = [];
    const res = await recheckPendingPayouts(async (x) => { lost.push(x.txid); });
    console.log("RECHECK " + JSON.stringify({ ...res, lostIsMine: lost[0] === r.txid, stillPending: payoutPending(r.txid) }));
    process.exit(0);
  `;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], {
    cwd: SERVER_DIR,
    env: { ...process.env, RECEIPT_WAIT_MS: "300", BROADCAST_RETRY_MS: "50", PENDING_LOST_AFTER_MS: "0", NODE_URL: node.url, DISTRIBUTOR_PRIVATE_KEY: randomBytes(32).toString("hex"), DISTRIBUTOR_DRY_RUN: "", NETWORK: "testnet" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
  await new Promise((r) => child.on("exit", r));
  node.srv.close();
  const m = /RECHECK (.*)/.exec(out);
  assert.ok(m, out);
  return JSON.parse(m[1]);
}

test("a pending payout that expired is reported as lost, not forgotten", async () => {
  const r = await recheck("expired");
  assert.equal(r.lost, 1);
  assert.equal(r.lostIsMine, true);
  assert.equal(r.stillPending, false);
});

test("a pending payout the node still holds stays pending", async () => {
  const r = await recheck("no-receipt");
  assert.equal(r.lost, 0);
  assert.equal(r.stillPending, true);
});
