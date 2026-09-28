// relayer/src/ratelimit.js
//
// M-5. How clients and notes are counted for rate limiting.
//
// express-rate-limit 7.5.1 keys on `request.ip` exactly. For IPv4 that is one client. For IPv6 it is
// one address out of the /64 or larger that any host hands out, so a single machine could rotate
// through 2^64 buckets and the limits did not apply to it at all. The limits are the only brake on
// submission floods, each of which costs a pairing check on this single-threaded process.
//
// IPv6 is therefore counted per /56, the smallest assignment a residential or hosting customer is
// commonly given. It is coarser than one household, so a large shared network (a university, a
// mobile carrier's NAT64) shares one bucket; that errs towards refusing some traffic, which for a
// relay that anyone can run and any user can switch away from is the cheaper mistake.

import { isIP } from "node:net";

const BN254_FR =
  21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Expand an IPv6 address to its eight 16-bit groups, or null if it is not one. */
function ipv6Groups(ip) {
  if (isIP(ip) !== 6) return null;
  let s = ip.toLowerCase();
  const pct = s.indexOf("%");
  if (pct >= 0) s = s.slice(0, pct); // zone index
  // Embedded IPv4 tail (::ffff:1.2.3.4, 64:ff9b::1.2.3.4) becomes two groups.
  const v4 = s.match(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b, c, d] = v4.slice(1).map(Number);
    s = s.slice(0, v4.index) + ((a << 8) | b).toString(16) + ":" + ((c << 8) | d).toString(16);
  }
  const [head, tail] = s.split("::");
  const h = head ? head.split(":") : [];
  const t = tail !== undefined && tail !== "" ? tail.split(":") : [];
  const fill = s.includes("::") ? 8 - h.length - t.length : 0;
  const groups = [...h, ...Array(fill).fill("0"), ...t].map((g) => parseInt(g || "0", 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

/**
 * The key a client is counted under: the IPv4 address itself, or the /56 prefix of an IPv6 one.
 * An IPv4-mapped address (::ffff:a.b.c.d) is the IPv4 client it wraps, since a dual-stack socket
 * reports IPv4 clients that way. Anything unparseable is counted as itself rather than dropped.
 */
export function rateLimitKey(ip) {
  const raw = String(ip ?? "");
  if (isIP(raw) === 4) return raw;
  const g = ipv6Groups(raw);
  if (!g) return `raw:${raw}`;
  const mapped = g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0xffff;
  if (mapped) return `${g[6] >> 8}.${g[6] & 0xff}.${g[7] >> 8}.${g[7] & 0xff}`;
  // /56 = the first three groups plus the high byte of the fourth.
  const hex = (n) => n.toString(16).padStart(4, "0");
  return `v6:${hex(g[0])}:${hex(g[1])}:${hex(g[2])}:${hex(g[3] & 0xff00)}::/56`;
}

/**
 * The key a note is counted under: its nullifier hash as the field element snarkjs and the program
 * see, so "5", "05" and "0x5" are one note. Values that are not a field element are all counted
 * together; they cannot be a real note, and one key stops them each holding memory for a minute.
 */
export function nullifierKey(value) {
  try {
    if (typeof value !== "string" || value.length === 0 || value.length > 80) return "invalid";
    const n = BigInt(value);
    return n >= 0n && n < BN254_FR ? n.toString() : "invalid";
  } catch {
    return "invalid";
  }
}
