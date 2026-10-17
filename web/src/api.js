// Fetch wrapper for the ClearLedger HTTP contract (the frozen /api contract: endpoints, field names, integer cents).
// Kept dependency-free: only the fetch and Web Crypto APIs already available in the target browsers.

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export function createClient({ getToken, onUnauthorized } = {}) {
  async function api(path, options = {}) {
    const token = getToken ? getToken() : '';
    let res;
    try {
      res = await fetch('/api/' + path, {
        ...options,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: 'Bearer ' + token } : {}),
          ...options.headers,
        },
      });
    } catch (e) {
      if (e && e.name === 'AbortError') throw e;
      throw new ApiError('Network error. Check your connection and try again.', 0);
    }
    let body = {};
    try {
      body = await res.json();
    } catch {
      // A non-JSON body (unexpected) still needs a readable failure message below.
    }
    if (!res.ok) {
      if (res.status === 401 && onUnauthorized) onUnauthorized();
      throw new ApiError(body.error || 'Request failed (' + res.status + ')', res.status);
    }
    return body;
  }
  return api;
}

// A request that must not hang forever: the investigate call is a synchronous backend
// operation that can call out to a local model, so give it a bounded client-side timeout
// distinct from "the server said no" failures. Retrying after a timeout is safe because
// investigation is idempotent per open case (it only ever replaces the current draft).
export async function withTimeout(promiseFactory, signal, ms, timeoutMessage) {
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort);
  const timer = setTimeout(() => controller.abort(), ms);
  try {
    return await promiseFactory(controller.signal);
  } catch (e) {
    if (e && e.name === 'AbortError') throw new ApiError(timeoutMessage, 408);
    throw e;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// Content-addressed idempotency key: identical (source, csv) always hashes to the same
// key, so retrying an unchanged submission automatically reuses it (satisfies "retry the
// same logical submission with the same key"), while any edit to the file or a change of
// source naturally produces a new key ("start a new submission"). No client-side session
// state is needed to tell those two cases apart.
export async function idempotencyKeyFor(source, csv) {
  const bytes = new TextEncoder().encode(source + '\n' + csv);
  // crypto.subtle only exists in secure contexts (HTTPS or localhost). A LAN deployment over
  // plain HTTP still needs a content-addressed key, so fall back to a local implementation.
  const digest = globalThis.crypto?.subtle ? new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)) : sha256(bytes);
  return Array.from(digest).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Minimal FIPS 180-4 SHA-256 over a byte array, used only when Web Crypto is unavailable.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);
export function sha256(bytes) {
  const bitLen = bytes.length * 8;
  const padded = new Uint8Array(((bytes.length + 9 + 63) >> 6) << 6);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLen / 2 ** 32));
  view.setUint32(padded.length - 4, bitLen >>> 0);
  const h = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const w = new Uint32Array(64);
  const rotr = (x, n) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
      const s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let i = 0; i < 64; i++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i] + w[i]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    h[0] += a; h[1] += b; h[2] += c; h[3] += d; h[4] += e; h[5] += f; h[6] += g; h[7] += hh;
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  h.forEach((x, i) => ov.setUint32(i * 4, x));
  return out;
}
