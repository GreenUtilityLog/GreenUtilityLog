// ── A broadcast whose reply is lost must not be paid again ───────────────────
// reward.js signs first and broadcasts second, so when the broadcast call fails
// it can ask the node whether the transaction arrived anyway. A fake node stands
// in for VeChain: it can take the transaction and drop the reply, or refuse it.

import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const SERVER_DIR = join(fileURLToPath(new URL(".", import.meta.url)), "..");

function fakeNode(mode, { revertSelector = null } = {}) {
  const seen = new Set();
  const raws = [];
  const best = { id: "0x00000a" + "1".repeat(58), number: 655360, timestamp: Math.floor(Date.now() / 1000), gasLimit: 40000000, baseFeePerGas: "0x9184e72a000", parentID: "0x" + "2".repeat(64) };
  const genesis = { id: "0x00000000" + "27".repeat(28), number: 0, timestamp: 1530014400, gasLimit: 10000000 };
  const srv = createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      const send = (o, c = 200) => { res.statusCode = c; res.setHeader("content-type", "application/json"); res.end(JSON.stringify(o)); };
      const u = req.url;
      if (u.startsWith("/blocks/0")) return send(genesis);
      if (u.startsWith("/blocks/best")) return send(best);
      if (u.startsWith("/fees/history")) return send({ oldestBlock: best.id, baseFeePerGas: ["0x9184e72a000"], gasUsedRatio: [0.5], reward: [["0x0"]] });
      if (u.startsWith("/fees/priority")) return send({ maxPriorityFeePerGas: "0x0" });
      if (u.startsWith("/accounts/*")) {
        const data = (JSON.parse(b || "{}").clauses || [])[0]?.data || "";
        const reverted = !!revertSelector && data.startsWith(revertSelector);
        return send([{ data: "0x", events: [], transfers: [], gasUsed: 30000, reverted, vmError: reverted ? "execution reverted" : "" }]);
      }
      if (u.startsWith("/accounts/")) return send({ balance: "0x0", energy: "0xffffffffffff", hasCode: false });
      if (req.method === "POST" && u.startsWith("/transactions")) {
        if (mode === "refused") return send({ error: "rejected" }, 400);
        seen.add("tx");
        raws.push(JSON.parse(b).raw);
        if (mode === "lost-reply") { res.socket.destroy(); return; } // took it, reply never came back
        return send({ id: "0x" });
      }
      if (req.method === "GET" && u.startsWith("/transactions/")) return send(seen.size ? { id: "0x" } : null);
      send(null);
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, seen, raws, url: `http://127.0.0.1:${srv.address().port}` })));
}

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
    env: { ...process.env, NODE_URL: node.url, DISTRIBUTOR_PRIVATE_KEY: randomBytes(32).toString("hex"), DISTRIBUTOR_DRY_RUN: "", NETWORK: "testnet" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = ""; child.stdout.on("data", (d) => (out += d)); child.stderr.on("data", (d) => (out += d));
  await new Promise((r) => child.on("exit", r));
  node.srv.close();
  return { out, received: node.seen.size > 0 };
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
    env: { ...process.env, NODE_URL: node.url, DISTRIBUTOR_PRIVATE_KEY: randomBytes(32).toString("hex"), DISTRIBUTOR_DRY_RUN: "", NETWORK: "testnet" },
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
