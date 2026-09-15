/**
 * Chunking and the merkle tree — the half of the packer a browser can run.
 *
 * Split out from pack.mjs because that module imports node:zlib for
 * compression, which makes the whole file unloadable in a page. The loader
 * needs exactly these functions and none of the compression, so the boundary
 * is drawn here rather than shipping a bundler to work around an import the
 * browser never needed.
 *
 * The rules that matter live here too. keccak256 rather than SHA-256, because
 * the EVM computes it natively and a contract can therefore verify a chunk
 * against the root — on Solana the proof is something the page performs; here
 * it is something the chain can do. And an odd node at the end of a level is
 * promoted rather than paired with itself: self-pairing is the classic
 * malleability bug, letting a tree of n leaves and one of n+1 share a root.
 */
import { keccak_256 } from "./vendor/noble-sha3.js";

/**
 * The largest chunk that can be stored, which is *not* the EIP-170 limit.
 *
 * EIP-170 caps deployed code at 24,576 bytes, and the STOP byte prefixed to
 * make the data non-executable is part of that budget. So a chunk may be at
 * most 24,575 bytes. Cutting at 24,576 produces a payload where every single
 * chunk is one byte too large to deploy — which does not show up until the
 * first write reverts on a real chain, long after the packing looked fine.
 */
export const MAX_CHUNK = 24575;

const hex = (u8) => "0x" + [...u8].map((b) => b.toString(16).padStart(2, "0")).join("");
const cat = (a, b) => { const o = new Uint8Array(a.length + b.length); o.set(a); o.set(b, a.length); return o; };
const unhex = (h) => Uint8Array.from(h.replace(/^0x/, "").match(/../g).map((x) => parseInt(x, 16)));

export const hash = (bytes) => keccak_256(bytes);

/** Split into fixed-size pieces; the last one is whatever remains. */
export function chunk(bytes, size = MAX_CHUNK) {
  if (!(size > 0 && size <= MAX_CHUNK)) {
    throw new Error("chunk size must be 1.." + MAX_CHUNK +
                    " bytes (EIP-170's 24576, less the STOP prefix)");
  }
  const out = [];
  for (let o = 0; o < bytes.length; o += size) out.push(bytes.subarray(o, Math.min(o + size, bytes.length)));
  return out;
}

/**
 * Merkle root over chunk hashes, plus every level so proofs can be cut later.
 *
 * An empty payload has no root. Returning a zero hash for it would make "no
 * data" indistinguishable from "data that happens to hash to zero", and the
 * loader would treat an empty publish as a valid one.
 */
export function merkle(leaves) {
  if (!leaves.length) throw new Error("nothing to root — empty payload");
  let level = leaves.map((l) => (l instanceof Uint8Array ? l : unhex(l)));
  const levels = [level];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      /* Odd tail is promoted, never self-paired. See the header. */
      next.push(i + 1 < level.length ? keccak_256(cat(level[i], level[i + 1])) : level[i]);
    }
    level = next;
    levels.push(level);
  }
  return { root: level[0], levels };
}

/** The sibling path proving `index` belongs under the root. */
export function proofFor(levels, index) {
  const path = [];
  let i = index;
  for (let d = 0; d < levels.length - 1; d++) {
    const level = levels[d];
    const sib = i % 2 === 0 ? i + 1 : i - 1;
    /* A promoted odd tail has no sibling at this level — nothing to add. */
    if (sib < level.length) path.push({ hash: hex(level[sib]), right: i % 2 === 0 });
    i = Math.floor(i / 2);
  }
  return path;
}

/** Recompute a root from a leaf and its path. Mirrors what a contract does. */
export function rootFromProof(leafHash, path) {
  let acc = leafHash instanceof Uint8Array ? leafHash : unhex(leafHash);
  for (const step of path) {
    const sib = unhex(step.hash);
    acc = keccak_256(step.right ? cat(acc, sib) : cat(sib, acc));
  }
  return acc;
}

