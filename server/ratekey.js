// The key the limits count by. An IPv6 user is handed a whole /64 (2^64 addresses)
// and can pick a new one per request, so per-address limits meant nothing there:
// IPv6 counts per /64, IPv4 (also written as ::ffff:a.b.c.d) per address.
export function rateKeyFor(ip) {
  const v = String(ip || "").toLowerCase();
  const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  if (!v.includes(":")) return v || "unknown";
  const [head, tail = ""] = v.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const groups = v.includes("::") ? [...h, ...Array(Math.max(0, 8 - h.length - t.length)).fill("0"), ...t] : h;
  return groups.slice(0, 4).map((g) => (g || "0").replace(/^0+(?=.)/, "")).join(":") + "::/64";
}
