/**
 * The page.
 *
 * It does one thing that matters: it reads a program out of chain state and
 * refuses to run anything it cannot prove. The loader, the merkle logic and
 * the cost model are copied verbatim from the tested source by
 * `script/sync-site.mjs`, and `npm test` fails if they drift — a page that
 * verifies with its own separate copy would be the copy nobody tests.
 *
 * Every step is narrated in the console panel because the narration *is* the
 * product. "Loading…" and then a game appearing proves nothing; a log that
 * names each contract read, states the root it rebuilt, and says which check
 * passed is the only part a visitor can actually check.
 */
import { rpcOver, loadRom, readHeader, browserInflate } from "./load.mjs";
import { bootRom, describe } from "./boot.mjs";
import { openBundle } from "./bundle.mjs";
import { isEmscriptenBundle, bootEmscripten, start } from "./emscripten.mjs";
import { proofFor, merkle, hash } from "./merkle.mjs";
import { quote, CHAINS, PAYLOADS } from "./cost.mjs";

/**
 * Where to read from.
 *
 * DEPTH, published to Robinhood Chain (id 4663) on 2026-09-15.
 * Earlier ROMs remain where they were — 0xaaa063de… (XOR field) and
 * 0x358e1302… (DEPTH before mouse look). Sealing is one-way, so every
 * revision is a new ROM rather than a replacement, and the old ones stay
 * readable forever. The empty-state branch
 * below is kept rather than deleted: if this is ever pointed at an unpublished
 * chain, "nothing has been published yet" and "the chain is unreachable" are
 * different problems and should not look alike.
 */
const CONFIG = {
  rpc: "https://rpc.mainnet.chain.robinhood.com",
  chainName: "Robinhood Chain",
  rom: "0x5b2ed277a723c71b4e1c041e1ce0035c313ae931",
};

/* `?rom=0x…&rpc=…` overrides the defaults. This is how the page is tested
   against a local node before anything is published, and it is also the honest
   shape for a reader of public data: nothing here is privileged, so anyone can
   point it at another ROM or another node and get the same guarantees — the
   verification does not depend on which endpoint answered. */
{
  const q = new URLSearchParams(location.search);
  if (q.get("rpc")) CONFIG.rpc = q.get("rpc");
  if (/^0x[0-9a-fA-F]{40}$/.test(q.get("rom") || "")) CONFIG.rom = q.get("rom");
}

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

/* ── console ─────────────────────────────────────────────────────────── */

let lines = [];
function say(text, cls = "") {
  lines.push(cls ? `<span class="${cls}">${esc(text)}</span>` : esc(text));
  const el = $("log");
  el.innerHTML = lines.join("\n");
  el.scrollTop = el.scrollHeight;
}
function status(text, state) {
  $("statusText").textContent = text;
  $("statusDot").className = "dot" + (state ? " " + state : "");
}
const setBar = (frac) => { $("barFill").style.width = Math.max(0, Math.min(1, frac)) * 100 + "%"; };

const fmtBytes = (n) =>
  n >= 1048576 ? (n / 1048576).toFixed(2) + " MB"
  : n >= 1024 ? (n / 1024).toFixed(1) + " KB" : n + " B";

/* ── the cost table, from the same model the tests cover ─────────────── */

function renderCosts() {
  const chain = CHAINS.robinhood;
  const money = (n) => (n < 1 ? "$" + n.toFixed(2) : "$" + n.toLocaleString(undefined, { maximumFractionDigits: 0 }));
  $("costRows").innerHTML = PAYLOADS.map((p) => {
    const q = quote(p.bytes, chain);
    return `<tr>
      <td>${esc(p.name)}</td>
      <td>${fmtBytes(p.bytes)}</td>
      <td class="num">${money(q.calldata.usd)}</td>
      <td class="num">${money(q.sstore2.usd)}</td>
      <td>${q.sstore2.chunks.toLocaleString()}</td>
    </tr>`;
  }).join("");
}

/* ── loading ─────────────────────────────────────────────────────────── */

let loaded = null;   // { bytes, header } once a ROM has been read and proved

async function load() {
  const btn = $("btnLoad");
  btn.disabled = true;
  lines = [];
  setBar(0);

  if (!CONFIG.rom) {
    /* The honest empty state. A placeholder address would fail in a way that
       looks like a bug in the loader rather than an absence of a ROM. */
    status("no ROM published", "");
    say("No ROM has been published yet.", "a");
    say("");
    say("The pipeline is built and proved end to end against a local EVM —", "d");
    say("packed, deployed as contract code, read back byte-identical, and the", "d");
    say("engine compiled and executed from chain state.", "d");
    say("");
    say("What is missing is a payload and a public deployment.", "d");
    btn.disabled = false;
    return;
  }

  const rpc = rpcOver(CONFIG.rpc);
  status("reading", "busy");
  say("rpc      " + CONFIG.rpc, "d");
  say("rom      " + CONFIG.rom, "d");
  say("");

  try {
    const header = await readHeader(CONFIG.rom, rpc);
    say("sealed   " + (header.sealed ? "yes" : "NO"), header.sealed ? "g" : "r");
    if (!header.sealed) {
      throw new Error("this ROM is not sealed — its root can still change, so it proves nothing");
    }
    say("chunks   " + header.chunkCount);
    say("root     " + header.root, "g");
    say("");

    $("mChunks").textContent = header.chunkCount.toLocaleString();
    $("mRoot").textContent = header.root.slice(0, 22) + "…";

    let readCount = 0;
    const res = await loadRom(CONFIG.rom, rpc, {
      inflate: browserInflate,
      onProgress: ({ phase, done, total }) => {
        if (phase === "pointers") {
          setBar((done / total) * 0.15);
          if (done === total) say("pointers " + total + " contract addresses", "d");
        } else if (phase === "chunks") {
          readCount = done;
          $("mReads").textContent = done.toLocaleString();
          setBar(0.15 + (done / total) * 0.7);
          if (done % Math.max(1, Math.floor(total / 8)) === 0 || done === total) {
            say("read     " + done + " / " + total + " contracts", "d");
          }
        } else if (phase === "inflate") {
          setBar(0.9);
          say("");
          say("root rebuilt from the chunks and matched", "g");
          say("body hash matched", "g");
          say("inflating…", "d");
        }
      },
    });

    setBar(1);
    say("inflated hash matched", "g");
    say("");
    say("verified " + fmtBytes(res.bytes.length) + " read from " + readCount + " contracts", "g");
    $("mBytes").textContent = fmtBytes(res.header.rawBytes || res.bytes.length);
    loaded = res;
    status("verified", "ok");

    await boot(res.bytes);
  } catch (e) {
    setBar(0);
    say("");
    say("REFUSED: " + e.message, "r");
    status("refused", "bad");
  } finally {
    btn.disabled = false;
  }
}

/* ── booting ─────────────────────────────────────────────────────────── */

let running = null;   // the cancel handle for the current frame loop

async function boot(bytes) {
  say("");
  say("opening the bundle…", "d");

  /* Stop whatever was running before loading again, or two engines end up
     drawing to the same canvas and the second load looks like corruption. */
  if (running) { running(); running = null; }

  /* A real 1990s engine compiles to a wasm module plus a JavaScript runtime,
     and a ROM holding one holds both. That runtime is executed — which is the
     premise rather than an oversight, and is safe only because these bytes
     have already been matched against the root the contract sealed. The
     verification above is what earns this. */
  try {
    const files = openBundle(bytes);
    if (isEmscriptenBundle(files)) return await bootNative(files);
  } catch (e) {
    say("");
    say("bundle: " + e.message, "a");
    status("verified, not booted", "ok");
    return;
  }

  try {
    const booted = await bootRom({
      bytes,
      canvas: $("screen"),
      onFiles: (data) => {
        for (const [name, b] of data) say("  " + name + "  " + fmtBytes(b.length), "d");
      },
      stdout: (line) => say("  " + line, "d"),
      stderr: (line) => say("  " + line, "a"),
    });

    const d = describe(booted);
    say("engine   " + booted.engineName, "g");
    say("exports  " + d.exports.join(", "), "d");
    if (booted.host) say("host     wasi_snapshot_preview1, read-only", "d");
    if (booted.display) say("host     framebuffer + input", "d");

    /* A palette file is optional, but a game that has one and does not get it
       loaded draws in greyscale — which looks like a broken engine rather than
       a skipped step. */
    if (booted.display) {
      const pal = booted.data.get("data/palette") || booted.data.get("data/PALETTE");
      if (pal) {
        const info = booted.display.loadPalette(pal, Math.min(256, Math.floor(pal.length / 3)));
        say("palette  " + (info.sixBit ? "256 entries, 6-bit VGA, scaled" : "256 entries, 8-bit"), "d");
      }
      booted.display.attach($("screen"));
      running = booted.display.listen(window);
    }

    say("");
    $("stageNote").hidden = true;

    /* Drive it. A compiled game usually exports either `frame` for a host-
       driven loop or `_start` for one that never returns — the second cannot
       be run on the main thread without freezing the tab, so it is named
       rather than attempted. */
    if (typeof booted.instance.exports.frame === "function") {
      say("running from chain state.", "g");
      status("running", "ok");
      let raf = 0, stop = false;
      const tick = () => {
        if (stop) return;
        try { booted.instance.exports.frame(); }
        catch (e) {
          stop = true;
          say("engine stopped: " + e.message, e.wasiExit ? "d" : "r");
          status(e.wasiExit ? "exited" : "faulted", e.wasiExit ? "ok" : "bad");
          return;
        }
        raf = requestAnimationFrame(tick);
      };
      const detach = running;
      running = () => { stop = true; cancelAnimationFrame(raf); if (detach) detach(); };
      tick();
    } else if (typeof booted.instance.exports._start === "function") {
      say("this engine exports _start, which does not return —", "a");
      say("it needs a worker to run without freezing the page.", "a");
      status("verified, not started", "ok");
    } else {
      say("no frame() or _start() — nothing to drive.", "a");
      status("verified, not booted", "ok");
    }
  } catch (e) {
    say("");
    say("boot: " + e.message, "a");
    $("stageNote").hidden = false;
    $("stageNote").textContent = e.message;
    status("verified, not booted", "ok");
  }
}

/**
 * Boot an emscripten-built engine — the shape a real game takes.
 *
 * The runtime comes off the chain with everything else and is imported from a
 * Blob URL, because none of these bytes exist as a file anywhere. The game's
 * data files are written into its in-memory filesystem before main() runs;
 * doing it afterwards is too late, and the game reports missing files that are
 * demonstrably present.
 */
async function bootNative(files) {
  try {
    say("emscripten runtime detected", "d");
    const booted = await bootEmscripten({
      files,
      canvas: $("screen"),
      onOutput: (line, kind) => say("  " + line, kind === "err" ? "a" : "d"),
      onStage: (names) => {
        for (const n of names) say("  staged " + n, "d");
      },
    });
    say("runtime  " + booted.glueName, "g");
    say("module   " + booted.wasmName, "g");
    say("");
    $("stageNote").hidden = true;
    say("starting the engine…", "g");
    status("running", "ok");
    /* callMain does not return for a game — asyncify keeps the browser
       responsive, but control stays inside the engine from here. */
    start(booted.instance);
  } catch (e) {
    say("");
    say("boot: " + e.message, "r");
    $("stageNote").hidden = false;
    $("stageNote").textContent = e.message;
    status("verified, not booted", "bad");
  }
}

/* ── the on-chain proof ──────────────────────────────────────────────── */

const selector = (sig) =>
  "0x" + [...hash(new TextEncoder().encode(sig)).slice(0, 4)]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
const word = (n) => BigInt(n).toString(16).padStart(64, "0");

async function spotCheck() {
  const btn = $("btnProof");
  const out = $("proofLog");
  btn.disabled = true;
  $("proofDot").className = "dot busy";
  $("proofText").textContent = "asking the chain";

  if (!loaded) {
    out.textContent = "Load a ROM first — the proof is checked against the chunks that " +
                      "were actually read, not against the page's own idea of them.";
    $("proofDot").className = "dot";
    $("proofText").textContent = "not run";
    btn.disabled = false;
    return;
  }

  const rpc = rpcOver(CONFIG.rpc);
  const total = loaded.chunkCount;
  const picks = [...new Set([0, 1, Math.floor(total / 3), Math.floor(total / 2),
                             total - 2, total - 1].filter((i) => i >= 0 && i < total))].slice(0, 6);

  const rows = [];
  let allOk = true;
  for (const i of picks) {
    try {
      /* The proof is cut locally and checked remotely. The answer comes from
         the EVM walking the tree with EXTCODECOPY — not from this page. */
      const path = proofFor(loaded.levels, i);
      const data = selector("verify(uint256,bytes32[])") +
        word(i) + word(64) + word(path.length) +
        path.map((s) => s.hash.replace(/^0x/, "")).join("");
      const r = await rpc("eth_call", [{ to: CONFIG.rom, data }, "latest"]);
      const good = BigInt(r) === 1n;
      allOk = allOk && good;
      rows.push("chunk " + String(i).padStart(4) + "   " + (good ? "verified on chain" : "REJECTED"));
    } catch (e) {
      allOk = false;
      rows.push("chunk " + String(i).padStart(4) + "   error: " + e.message);
    }
  }
  out.textContent = rows.join("\n") + "\n\n" +
    (allOk ? "The contract confirmed each of these against its own sealed root."
           : "At least one chunk did not verify. Do not trust this ROM.");
  $("proofDot").className = "dot " + (allOk ? "ok" : "bad");
  $("proofText").textContent = allOk ? "verified" : "failed";
  btn.disabled = false;
}

/* ── wiring ──────────────────────────────────────────────────────────── */

renderCosts();
$("btnLoad").addEventListener("click", load);
$("btnProof").addEventListener("click", spotCheck);

if (!CONFIG.rom) {
  status("no ROM published", "");
  $("log").textContent =
    "Nothing has been published yet. Press Load to see what the page would do.";
}
