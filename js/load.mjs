/**
 * Read a ROM back out of a chain and check it is the one that was published.
 *
 * This runs in the browser and in Node, because the page and the test suite
 * must exercise the same reader. A loader that only the tests have run is a
 * loader nobody has run.
 *
 * The important design choice is what it trusts, which is nothing:
 *
 *   - Chunks come from `eth_getCode` on each pointer, which is the cheapest
 *     way to read them (no contract call, no gas) but also the easiest for a
 *     hostile RPC to lie about.
 *   - So every chunk is hashed, the tree is rebuilt, and the root is compared
 *     to the one the contract committed to. A wrong chunk, a swapped pair, a
 *     missing piece and a padded list all fail here.
 *   - Then the concatenation is checked against `bodyHash`, and the inflated
 *     result against `rawHash`. Both, because a stream can inflate perfectly
 *     and still be the wrong game.
 *
 * An unsealed ROM is refused outright. Before sealing, the owner can still
 * append chunks and set any root they like, so "it matched the root" would
 * mean only that the publisher was internally consistent at the moment you
 * looked.
 */
import { keccak_256 } from "./vendor/noble-sha3.js";
import { merkle } from "./merkle.mjs";

const hex = (u8) => "0x" + [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
const unhex = (h) => {
  const s = h.replace(/^0x/, "");
  return s.length ? Uint8Array.from(s.match(/../g).map((x) => parseInt(x, 16))) : new Uint8Array(0);
};

/* Selectors are derived, never hardcoded. A mistyped constant produces a call
   that returns empty data, which decodes to zero — a live ROM would read as
   "0 chunks" and the failure would look like an empty publish. */
const selector = (sig) => hex(keccak_256(new TextEncoder().encode(sig)).slice(0, 4));

export const SIG = {
  chunkCount: "chunkCount()",
  chunks: "chunks(uint256)",
  root: "root()",
  bodyHash: "bodyHash()",
  rawHash: "rawHash()",
  rawBytes: "rawBytes()",
  sealed: "sealed_()",
  name: "name()",
};

const word = (n) => BigInt(n).toString(16).padStart(64, "0");

/** A minimal JSON-RPC caller; give it a URL or your own transport. */
export function rpcOver(endpoint, { headers = {}, attempts = 4 } = {}) {
  return async function rpc(method, params) {
    let last;
    for (let a = 0; a < attempts; a++) {
      try {
        const r = await fetch(endpoint, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        });
        const text = await r.text();
        /* Cloudflare-fronted RPCs answer an unadorned request with an HTML
           challenge, which otherwise surfaces much later as a JSON parse
           error about an unexpected '<'. */
        if (text.trim().startsWith("<")) throw new Error("RPC returned an HTML challenge page");
        const j = JSON.parse(text);
        if (j.error) throw new Error(j.error.message);
        return j.result;
      } catch (e) {
        last = e;
        if (a < attempts - 1) await new Promise((s) => setTimeout(s, 300 * 2 ** a));
      }
    }
    throw new Error("rpc " + method + " failed: " + last.message);
  };
}

const callTo = (rpc, to) => (data) => rpc("eth_call", [{ to, data }, "latest"]);

/** Everything the contract says about itself, before a byte is fetched. */
export async function readHeader(romAddress, rpc) {
  const call = callTo(rpc, romAddress);
  const [count, root, bodyHash, rawHash, rawBytes, sealed] = await Promise.all([
    call(selector(SIG.chunkCount)),
    call(selector(SIG.root)),
    call(selector(SIG.bodyHash)),
    call(selector(SIG.rawHash)),
    call(selector(SIG.rawBytes)),
    call(selector(SIG.sealed)),
  ]);
  return {
    address: romAddress,
    chunkCount: Number(BigInt(count || "0x0")),
    root: root,
    bodyHash,
    rawHash,
    rawBytes: Number(BigInt(rawBytes || "0x0")),
    sealed: BigInt(sealed || "0x0") === 1n,
  };
}

/** The pointer addresses, one per chunk, in order. */
export async function readPointers(romAddress, count, rpc, { onProgress } = {}) {
  const call = callTo(rpc, romAddress);
  const out = [];
  for (let i = 0; i < count; i++) {
    const r = await call(selector(SIG.chunks) + word(i));
    out.push("0x" + r.replace(/^0x/, "").slice(24));
    if (onProgress) onProgress({ phase: "pointers", done: i + 1, total: count });
  }
  return out;
}

/**
 * A chunk's bytes, straight from the pointer's code.
 *
 * The leading STOP byte that makes the data non-executable is stripped here.
 * Forgetting it shifts every byte by one — the payload still hashes to
 * something, just never to the root, and the error surfaces as a root mismatch
 * far from its cause.
 */
export async function readChunk(pointer, rpc) {
  const code = await rpc("eth_getCode", [pointer, "latest"]);
  const bytes = unhex(code);
  if (bytes.length === 0) throw new Error("pointer " + pointer + " holds no code");
  if (bytes[0] !== 0x00) throw new Error("pointer " + pointer + " is not a data contract");
  return bytes.subarray(1);
}

/**
 * Fetch, verify and inflate the whole ROM.
 *
 * `inflate` is injected so the same function serves both runtimes: the browser
 * passes a DecompressionStream wrapper, Node passes zlib. Neither is imported
 * here, so this module stays loadable in both.
 */
export async function loadRom(romAddress, rpc, { inflate, onProgress, concurrency = 8 } = {}) {
  const header = await readHeader(romAddress, rpc);
  if (!header.sealed) {
    throw new Error("this ROM is not sealed — its root can still change, so it proves nothing");
  }
  if (!header.chunkCount) throw new Error("this ROM holds no chunks");

  const pointers = await readPointers(romAddress, header.chunkCount, rpc, { onProgress });

  /* Fetched in bounded parallel: one at a time is slow over hundreds of
     chunks, and all at once gets an RPC to rate-limit or drop requests. */
  const chunks = new Array(pointers.length);
  let next = 0, done = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= pointers.length) return;
      chunks[i] = await readChunk(pointers[i], rpc);
      done++;
      if (onProgress) onProgress({ phase: "chunks", done, total: pointers.length });
    }
  };
  await Promise.all([...Array(Math.min(concurrency, pointers.length))].map(worker));

  /* Rebuild the tree from what actually arrived and compare with what the
     contract committed to. This is the whole trust model in three lines. */
  const { root, levels } = merkle(chunks.map((c) => keccak_256(c)));
  if (hex(root).toLowerCase() !== header.root.toLowerCase()) {
    throw new Error("root mismatch — these chunks are not the published ROM");
  }

  const total = chunks.reduce((n, c) => n + c.length, 0);
  const body = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) { body.set(c, o); o += c.length; }
  if (hex(keccak_256(body)).toLowerCase() !== header.bodyHash.toLowerCase()) {
    throw new Error("reassembled bytes do not match the published body hash");
  }

  if (onProgress) onProgress({ phase: "inflate", done: 0, total: 1 });
  const raw = await inflate(body);
  if (hex(keccak_256(raw)).toLowerCase() !== header.rawHash.toLowerCase()) {
    throw new Error("inflated bytes do not match the published hash — wrong game");
  }
  if (header.rawBytes && raw.length !== header.rawBytes) {
    throw new Error("inflated length " + raw.length + " != published " + header.rawBytes);
  }
  if (onProgress) onProgress({ phase: "done", done: 1, total: 1 });

  /* The tree levels come back so a caller can cut a merkle proof for any chunk
     and have the *contract* check it. Rebuilding the tree separately would mean
     the proof was cut from a different tree than the one just verified — the
     kind of near-miss that looks like it is working. */
  return { bytes: raw, header, chunkCount: chunks.length, levels };
}

/** Browser inflate, using the platform's own gzip. No library needed. */
export async function browserInflate(body) {
  const ds = new DecompressionStream("gzip");
  const stream = new Blob([body]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
