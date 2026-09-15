/**
 * What it costs to put a whole game inside an EVM chain.
 *
 * This is the module that decides the architecture, so it is worth being
 * precise about the thing that makes EVM different from the Solana version.
 *
 * On Solana, a program cannot read transaction data. The bytes are in the
 * ledger and an RPC will hand them back, but nothing on chain can look at
 * them — the "on-chain game" is really an off-chain reader pointed at
 * permanent storage. The EVM has both options, and they are not equivalent:
 *
 *   CALLDATA   Bytes in a transaction's input field. Permanent in chain
 *              history and retrievable by `eth_getTransactionByHash`, but
 *              invisible to contracts. This is the direct Solana equivalent.
 *              16 gas per non-zero byte (EIP-2028).
 *
 *   SSTORE2    Bytes deployed *as contract code*, read back with
 *              EXTCODECOPY. Costs more, and it is capped at 24,576 bytes per
 *              contract (EIP-170) so a big payload becomes many contracts —
 *              but the chain itself can read it. A contract can hash the game,
 *              serve a level, gate on a byte range. Solana has no equivalent
 *              for transaction data.
 *              200 gas per byte deposited.
 *
 * The honest framing for a project like this is that calldata is "stored on
 * chain" and SSTORE2 is "readable by the chain", and only the second is a
 * capability the Solana version could not have had.
 *
 * Two traps worth naming because both silently change the answer:
 *
 *   EIP-7623.  On mainnet, a transaction that is mostly data now pays a
 *              *floor* of 10 gas per token, where a non-zero byte is 4
 *              tokens — so 40 gas/byte, not 16, for exactly this workload.
 *              Costing a data dump at 16 understates mainnet by 2.5x.
 *
 *   BLOBS.     EIP-4844 blobs are far cheaper and look like the obvious answer
 *              until you notice consensus clients drop them after roughly 18
 *              days. Blobs are not storage. They are excluded here on purpose.
 */

/** Gas constants, each tied to the EIP that set it. */
export const GAS = {
  txBase: 21000,                 // every transaction
  calldataNonZero: 16,           // EIP-2028
  calldataZero: 4,               // EIP-2028
  calldataFloorPerToken: 10,     // EIP-7623 floor
  tokensPerNonZeroByte: 4,       // EIP-7623
  tokensPerZeroByte: 1,          // EIP-7623
  codeDepositPerByte: 200,       // contract code deposit
  createBase: 32000,             // CREATE
  maxContractBytes: 24576,       // EIP-170, total deployed code
  /* One of those bytes is the STOP prefix that stops the data being
     executable, so a chunk of payload may be at most 24,575. Sizing contract
     count off the raw limit undercounts by one contract per ~24 KB. */
  usableContractBytes: 24575,
};

/**
 * A chain's fee conditions.
 *
 * `eip7623` marks chains that apply the data floor. L2s generally do not — they
 * charge their own L1 data fee instead, which is already inside the gas price
 * they quote, so applying both would double-count.
 */
export const CHAINS = {
  robinhood: { name: "Robinhood Chain", gwei: 0.069252, nativeUsd: 2490, eip7623: false,
               note: "Orbit L2, live reading 2026-09-15" },
  mainnet:   { name: "Ethereum mainnet", gwei: 1, nativeUsd: 2490, eip7623: true,
               note: "at 1 gwei; multiply through for busier conditions" },
  mainnet10: { name: "Ethereum mainnet", gwei: 10, nativeUsd: 2490, eip7623: true,
               note: "at 10 gwei" },
};

/**
 * Gas to publish `bytes` as transaction calldata.
 *
 * `nonZeroFrac` matters more than it looks: zero bytes are four times cheaper,
 * and compressed data is almost entirely non-zero. Assuming a friendly mix on
 * gzipped input would understate the bill, so the default assumes the worst
 * and the packer's real measurement should be passed in.
 */
export function calldataGas(bytes, { chunkBytes = 100_000, nonZeroFrac = 1, eip7623 = false } = {}) {
  const chunks = Math.ceil(bytes / chunkBytes);
  const nz = Math.round(bytes * nonZeroFrac), z = bytes - nz;
  const standard = nz * GAS.calldataNonZero + z * GAS.calldataZero + chunks * GAS.txBase;
  if (!eip7623) return { gas: standard, chunks, model: "EIP-2028" };
  /* The floor applies per transaction and, for a pure data dump, it is what
     you actually pay — the execution side of these transactions is trivial. */
  const tokens = nz * GAS.tokensPerNonZeroByte + z * GAS.tokensPerZeroByte;
  const floor = tokens * GAS.calldataFloorPerToken + chunks * GAS.txBase;
  return { gas: Math.max(standard, floor), chunks, model: floor > standard ? "EIP-7623 floor" : "EIP-2028" };
}

/** Gas to publish `bytes` as contract code, readable on chain. */
export function sstore2Gas(bytes, { perContract = GAS.usableContractBytes } = {}) {
  const contracts = Math.ceil(bytes / perContract);
  /* The deposit is paid on the stored code, which includes the STOP byte. */
  const gas = (bytes + contracts) * GAS.codeDepositPerByte
            + contracts * (GAS.createBase + GAS.txBase);
  return { gas, chunks: contracts, model: "code deposit" };
}

export function usd(gas, chain) {
  return gas * chain.gwei * 1e-9 * chain.nativeUsd;
}

/** Both approaches on one chain, for a payload of `bytes`. */
export function quote(bytes, chain, opts = {}) {
  const cd = calldataGas(bytes, { ...opts, eip7623: chain.eip7623 });
  const s2 = sstore2Gas(bytes, opts);
  return {
    bytes,
    calldata: { ...cd, usd: usd(cd.gas, chain) },
    sstore2:  { ...s2, usd: usd(s2.gas, chain) },
  };
}

/* ── report ─────────────────────────────────────────────────────────────── */

const mb = (n) => (n / 1048576).toFixed(2) + " MB";
const money = (n) => n < 1 ? "$" + n.toFixed(3)
                   : "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 });

/* Candidate payloads. Sizes are gzipped where a real figure is known, because
   that is what actually goes on chain. */
export const PAYLOADS = [
  { name: "ZZT (1991)",                   bytes: 200 * 1024,        licence: "freeware, source MIT" },
  { name: "Wolfenstein 3D shareware",     bytes: 1.4 * 1048576,     licence: "shareware, redistributable" },
  { name: "Doom shareware (their build)", bytes: 2.24 * 1048576,    licence: "shareware, redistributable" },
  { name: "FreeDM (free Doom deathmatch)",bytes: 10.81 * 1048576,   licence: "BSD — unambiguously free" },
  { name: "Freedoom, both phases",        bytes: 23.03 * 1048576,   licence: "BSD — unambiguously free" },
];

/* Guarded on `typeof process` so this module is loadable in a browser, where
   `process` does not exist and a bare reference is a ReferenceError at import
   time — the page would fail before any of its own code ran. */
if (typeof process !== "undefined" && process.argv?.[1]?.endsWith("cost.mjs")) {
  console.log("\n  Putting a game inside an EVM chain — what it costs\n");
  for (const [key, chain] of Object.entries(CHAINS)) {
    console.log("  " + chain.name + " @ " + chain.gwei + " gwei" +
                (chain.eip7623 ? "  (EIP-7623 data floor applies)" : "") +
                "\n  " + "-".repeat(74));
    console.log("  " + "payload".padEnd(32) + "size".padEnd(10) +
                "calldata".padEnd(14) + "SSTORE2".padEnd(14) + "contracts");
    for (const p of PAYLOADS) {
      const q = quote(p.bytes, chain);
      console.log("  " + p.name.padEnd(32) + mb(p.bytes).padEnd(10) +
                  money(q.calldata.usd).padEnd(14) +
                  money(q.sstore2.usd).padEnd(14) +
                  q.sstore2.chunks.toLocaleString());
    }
    console.log();
  }
  console.log("  calldata = stored on chain, read by an RPC (the Solana equivalent)");
  console.log("  SSTORE2  = readable BY the chain, which Solana cannot do for tx data\n");
}
