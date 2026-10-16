// ── The AI photo check against answers that carry no verdict ─────────────────
// A declined answer (stop_reason "refusal") has no text, which used to be read as
// "{}" — no bad label, so the photo was paid unchecked. These run the server against
// a stand-in Anthropic API that answers each way.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { startServer, photo, stateWithBaseline, WALLET } from "./helpers.mjs";

function fakeAnthropic(answer) {
  const models = [];
  const api = createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      const body = JSON.parse(b || "{}");
      models.push(body.model);
      const isVerdict = JSON.stringify(body).includes("final_label");
      const { stop_reason, text } = answer(isVerdict);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({
        id: "msg_test", type: "message", role: "assistant", model: body.model,
        content: text == null ? [] : [{ type: "text", text }],
        stop_reason, stop_details: stop_reason === "refusal" ? { type: "refusal", category: null, explanation: "declined" } : null,
        usage: { input_tokens: 10, output_tokens: 10 },
      }));
    });
  });
  return { api, models };
}

const CLEAN = JSON.stringify({ final_label: "clean", final_confidence: 0.9 });
const READS_1008 = JSON.stringify({ reading: "1008", all_numbers: [], confidence: 0.9 });

async function serverWith(answer) {
  const fake = fakeAnthropic(answer);
  await new Promise((r) => fake.api.listen(0, "127.0.0.1", r));
  const srv = await startServer({
    state: stateWithBaseline(),
    env: { ANTHROPIC_API_KEY: "test-key", ANTHROPIC_BASE_URL: `http://127.0.0.1:${fake.api.address().port}` },
  });
  return { srv, fake };
}

const submit = (srv, tag) => srv.post("/reward", {
  utility: "electric", meterNo: "E1000", address: WALLET,
  reading: 1008, prevRead: 1000, photo: photo(tag), photoMime: "image/jpeg",
});

describe("the AI photo check, when the model declines to answer", () => {
  let srv, fake;
  before(async () => ({ srv, fake } = await serverWith(() => ({ stop_reason: "refusal", text: null }))));
  after(async () => { await srv.stop(); fake.api.close(); });

  test("pays nothing and says to try again", async () => {
    const r = await submit(srv, "refused");
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.match(r.body.error, /try again/i);
    assert.equal(r.body.txid, undefined);
    assert.equal(srv.readState().readings["electric:e1000"], 1000, "baseline untouched");
  });
});

describe("the AI photo check, when the verdict is cut off", () => {
  let srv, fake;
  before(async () => ({ srv, fake } = await serverWith(() => ({ stop_reason: "max_tokens", text: "{\"final_label\":\"cl" }))));
  after(async () => { await srv.stop(); fake.api.close(); });

  test("pays nothing", async () => {
    const r = await submit(srv, "cut");
    assert.equal(r.status, 503, JSON.stringify(r.body));
    assert.equal(r.body.txid, undefined);
  });
});

describe("the AI photo check, with a clean verdict", () => {
  let srv, fake;
  before(async () => ({ srv, fake } = await serverWith((isVerdict) => ({ stop_reason: "end_turn", text: isVerdict ? CLEAN : READS_1008 }))));
  after(async () => { await srv.stop(); fake.api.close(); });

  test("pays, using the cheap model unless another is configured", async () => {
    const r = await submit(srv, "clean");
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(fake.models.length >= 1);
    assert.deepEqual([...new Set(fake.models)], ["claude-haiku-5-5"]);
  });
});
