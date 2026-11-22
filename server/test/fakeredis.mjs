// Upstash REST stand-in with expiry: MGET, GET, SET (NX/PX), DEL, PEXPIRE, PTTL and
// EVAL (the store's compare-and-set script). `delayReply(pattern, ms)` executes the next matching
// command at once but answers only after `ms` (a reply lost/late on the wire).
import { createServer } from "node:http";

export function fakeUpstash(initialState) {
  const kv = new Map();
  const exp = new Map();
  if (initialState) kv.set("greenutilitylog:state", JSON.stringify(initialState));
  const delays = [];
  const log = [];
  const live = (k) => { if (exp.has(k) && exp.get(k) <= Date.now()) { kv.delete(k); exp.delete(k); } return kv.has(k); };
  const srv = createServer((req, res) => {
    let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => {
      const args = JSON.parse(b || "[]");
      const [cmd, key, val, ...opts] = args;
      let result = null;
      if (cmd === "MGET") result = args.slice(1).map((k) => (live(k) ? kv.get(k) : null));
      else if (cmd === "GET") result = live(key) ? kv.get(key) : null;
      else if (cmd === "PTTL") result = live(key) ? (exp.has(key) ? exp.get(key) - Date.now() : -1) : -2;
      else if (cmd === "EVAL") {
        const [, , , stateKey, versionKey, expected, blob] = args;
        if ((kv.get(versionKey) || "0") === expected) {
          kv.set(stateKey, blob);
          const v = String(Number(kv.get(versionKey) || "0") + 1);
          kv.set(versionKey, v);
          result = Number(v);
        } else result = 0;
      } else if (cmd === "SET") {
        const nx = opts.includes("NX"), px = opts.indexOf("PX");
        if (nx && live(key)) result = null;
        else {
          kv.set(key, val); result = "OK";
          if (px >= 0) exp.set(key, Date.now() + Number(opts[px + 1])); else exp.delete(key);
        }
      } else if (cmd === "PEXPIRE") { if (live(key)) { exp.set(key, Date.now() + Number(val)); result = 1; } else result = 0; }
      else if (cmd === "DEL") { const had = live(key); kv.delete(key); exp.delete(key); result = had ? 1 : 0; }
      log.push({ at: Date.now(), cmd, key, result });
      const i = delays.findIndex((d) => d.cmd === cmd && d.re.test(String(key || "")));
      const send = () => { try { res.end(JSON.stringify({ result })); } catch {} };
      if (i >= 0) { const d = delays.splice(i, 1)[0]; setTimeout(send, d.ms); } else send();
    });
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({
    srv, kv, log, url: `http://127.0.0.1:${srv.address().port}`,
    delayReply: (cmd, re, ms) => delays.push({ cmd, re, ms }),
    once: () => [...kv.keys()].filter((k) => k.includes(":once:") && live(k)),
    state: () => JSON.parse(kv.get("greenutilitylog:state") || "{}"),
  })));
}
