/**
 * A container for the several files a game actually is.
 *
 * The ROM stores one byte string, but a playable game is an engine plus its
 * data. So the payload is a bundle: a small header naming each file, then the
 * files end to end. Compression happens once over the whole thing, outside
 * this module, which compresses better than per-file and keeps the ROM's
 * hashes committing to the bundle exactly as stored.
 *
 * The parser is written defensively on purpose. These bytes arrive from a
 * chain via an RPC, and although the merkle root proves they are the bytes
 * that were published, it proves nothing about whether they are *well formed*
 * — a publisher can commit to a malformed bundle as easily as a good one. Every
 * length is therefore checked against what remains, because the alternative is
 * a header claiming a four-gigabyte file and a browser tab that dies trying to
 * allocate it.
 */

const MAGIC = [0x43, 0x52, 0x4f, 0x4d];   // "CROM"
const VERSION = 1;
export const HEADER_MAGIC = "CROM";

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Build a bundle from `[name, bytes]` entries.
 *
 * Order is preserved and names must be unique — a duplicate name would make
 * lookup depend on which one the reader happened to keep, which is the kind of
 * ambiguity that shows up only once a payload is already immutable on a chain.
 */
export function buildBundle(files) {
  const entries = [...files];
  if (!entries.length) throw new Error("a bundle needs at least one file");

  const seen = new Set();
  for (const [name] of entries) {
    if (!name) throw new Error("every file needs a name");
    if (seen.has(name)) throw new Error("duplicate file name in bundle: " + name);
    seen.add(name);
  }

  const named = entries.map(([name, bytes]) => ({
    name, nameBytes: enc.encode(name),
    bytes: bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes),
  }));
  for (const f of named) {
    if (f.nameBytes.length > 0xffff) throw new Error("file name too long: " + f.name);
  }

  let headerLen = 4 + 1 + 4;                       // magic, version, count
  for (const f of named) headerLen += 2 + f.nameBytes.length + 4;
  const bodyLen = named.reduce((n, f) => n + f.bytes.length, 0);

  const out = new Uint8Array(headerLen + bodyLen);
  const view = new DataView(out.buffer);
  let o = 0;
  out.set(MAGIC, o); o += 4;
  out[o++] = VERSION;
  view.setUint32(o, named.length, false); o += 4;
  for (const f of named) {
    view.setUint16(o, f.nameBytes.length, false); o += 2;
    out.set(f.nameBytes, o); o += f.nameBytes.length;
    view.setUint32(o, f.bytes.length, false); o += 4;
  }
  for (const f of named) { out.set(f.bytes, o); o += f.bytes.length; }
  return out;
}

/**
 * Read a bundle back. Returns a Map of name → bytes, in published order.
 *
 * Every failure here is a clear message rather than a thrown RangeError from
 * some subarray call ten frames down, because the person reading it will be
 * looking at a page that says "loading" and nothing else.
 */
export function openBundle(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const need = (o, n, what) => {
    if (o + n > b.length) {
      throw new Error("bundle truncated: needed " + n + " bytes for " + what +
                      " at offset " + o + ", only " + (b.length - o) + " remain");
    }
  };

  need(0, 9, "the header");
  for (let i = 0; i < 4; i++) {
    if (b[i] !== MAGIC[i]) throw new Error("not a CROM bundle");
  }
  const version = b[4];
  if (version !== VERSION) {
    throw new Error("bundle version " + version + " — this reader understands " + VERSION);
  }

  const view = new DataView(b.buffer, b.byteOffset, b.byteLength);
  let o = 5;
  const count = view.getUint32(o, false); o += 4;
  /* A count is four bytes and can claim four billion files. Bounding it by the
     smallest a file entry could possibly be stops a malformed header sending
     the loop into an allocation storm before any length check runs. */
  if (count === 0) throw new Error("bundle declares no files");
  if (count > (b.length - 9) / 6) {
    throw new Error("bundle declares " + count + " files, too many for its size");
  }

  const dir = [];
  for (let i = 0; i < count; i++) {
    need(o, 2, "a file name length");
    const nameLen = view.getUint16(o, false); o += 2;
    need(o, nameLen, "a file name");
    const name = dec.decode(b.subarray(o, o + nameLen)); o += nameLen;
    need(o, 4, "a file size");
    const size = view.getUint32(o, false); o += 4;
    dir.push({ name, size });
  }

  const total = dir.reduce((n, d) => n + d.size, 0);
  if (o + total !== b.length) {
    throw new Error("bundle body is " + (b.length - o) + " bytes but its directory " +
                    "describes " + total);
  }

  const files = new Map();
  for (const d of dir) {
    files.set(d.name, b.subarray(o, o + d.size));
    o += d.size;
  }
  return files;
}

/** The first file whose name ends in `.wasm`, which is the engine. */
export function findEngine(files) {
  for (const [name, bytes] of files) {
    if (name.toLowerCase().endsWith(".wasm")) return { name, bytes };
  }
  throw new Error("no .wasm in this bundle — nothing to run");
}
