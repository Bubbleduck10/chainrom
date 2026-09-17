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
 * The chain and node are fixed; the ROM is chosen from the library below.
 * DEPTH was published to Robinhood Chain (id 4663) on 2026-09-15. Earlier ROMs
 * remain where they were — 0xaaa063de… (XOR field) and 0x358e1302… (DEPTH
 * before mouse look). Sealing is one-way, so every revision is a new ROM rather
 * than a replacement, and the old ones stay readable forever.
 */
const CONFIG = {
  rpc: "https://rpc.mainnet.chain.robinhood.com",
  chainName: "Robinhood Chain",
  rom: null,          // set by selectGame() from the chosen entry below
};

/**
 * The library. Each game is an independent ROM — a permanent address, not a
 * mutable slot — and a second one is here to make the point the loader is
 * general: it boots whatever it verifies, not the one game it was built for.
 * A `rom` of null means "written and compiled, not yet sealed on chain"; the
 * empty state names that rather than failing like a bug in the loader.
 */
const GAMES = [
  {
    id: "depth", name: "DEPTH", tag: "First-person maze",
    rom: "0x5b2ed277a723c71b4e1c041e1ce0035c313ae931",
    note: "Collect the lamps, then find the exit. Click the view to capture the " +
          "mouse; WASD to move, A/D or arrows to turn, Q/E to strafe.",
  },
  {
    id: "siege", name: "SIEGE", tag: "Top-down arena shooter",
    rom: "0x16f5c165e7ab37712949e71502072439f0191b4a",
    note: "Hold out against the waves. Click the field to start; WASD to move, " +
          "click to shoot toward the cursor (hold for auto-fire). One life.",
  },
];

/* `?game=<id>` picks a game; `?rom=0x…&rpc=…` override the target. The override
   is how the page is tested against a local node before anything is published:
   it points the selected game at another ROM or node and gets the same
   guarantees, because nothing here is privileged. */
let selected = 0;
const romOverride = (() => {
  const q = new URLSearchParams(location.search);
  if (q.get("rpc")) CONFIG.rpc = q.get("rpc");
  const g = GAMES.findIndex((x) => x.id === q.get("game"));
  if (g >= 0) selected = g;
  return /^0x[0-9a-fA-F]{40}$/.test(q.get("rom") || "") ? q.get("rom") : null;
})();

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

/* ── game picker ─────────────────────────────────────────────────────── */

function renderPicker() {
  const el = $("picker");
  if (!el) return;
  el.innerHTML = GAMES.map((g, i) =>
    `<button class="pick${g.rom ? "" : " soon"}" data-i="${i}" role="tab" aria-selected="${i === selected}">
       <b>${esc(g.name)}</b><span>${esc(g.tag)}</span>${g.rom ? "" : '<i class="badge">soon</i>'}
     </button>`).join("");
  el.querySelectorAll(".pick").forEach((b) =>
    b.addEventListener("click", () => selectGame(+b.dataset.i)));
}

/* Switching games stops the running engine and clears the panel, so one game's
   state never lingers under another's name. It does not auto-load — the whole
   point of the page is that reading a ROM off the chain is a deliberate act. */
function selectGame(i) {
  /* Once a game has booted, its emscripten engine owns the shared #screen canvas
     and cannot be cleanly torn down — a second engine on the same canvas means
     two main loops fighting over it, and DEPTH wants pointer lock while SIEGE
     refuses it. So switching to a different game after one has loaded reloads the
     page into that game with a clean canvas, rather than swapping in place. */
  if (loaded && GAMES[i] && GAMES[i].id !== GAMES[selected].id) {
    location.search = "?game=" + GAMES[i].id;
    return;
  }
  selected = i;
  const g = GAMES[i];
  CONFIG.rom = romOverride || g.rom;

  if (running) { running(); running = null; }
  loaded = null;
  lines = [];
  $("log").textContent = "waiting.";
  setBar(0);
  for (const id of ["mChunks", "mBytes", "mReads", "mRoot"]) $(id).textContent = "—";
  $("stageNote").hidden = false;
  $("stageNote").textContent = g.note;
  $("proofLog").textContent = "verify(index, proof) — evaluated on chain.";
  $("proofDot").className = "dot";
  $("proofText").textContent = "not run";

  const picker = $("picker");
  if (picker) picker.querySelectorAll(".pick").forEach((b) =>
    b.setAttribute("aria-selected", (+b.dataset.i === i).toString()));

  const btn = $("btnLoad");
  if (CONFIG.rom) {
    btn.disabled = false;
    btn.textContent = "Load from chain";
    status("idle", "");
  } else {
    btn.disabled = true;
    btn.textContent = "Not on chain yet";
    status(g.name + " — not on chain yet", "");
  }
}

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
      canvas: $("canvas"),
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
      booted.display.attach($("canvas"));
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
      canvas: $("canvas"),
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
    /* Focus the canvas so the keyboard reaches the engine without a click
       first — the arrow keys drive shooting in SIEGE. */
    try { $("canvas").focus(); } catch (e) {}
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
renderPicker();
$("btnLoad").addEventListener("click", load);
$("btnProof").addEventListener("click", spotCheck);

/* Fullscreen the game stage, and focus the canvas on entering so the keyboard
   reaches the engine at once. Works for either game — it acts on the stage. */
$("btnFull").addEventListener("click", () => {
  const stage = document.querySelector(".stage");
  if (document.fullscreenElement) { if (document.exitFullscreen) document.exitFullscreen(); return; }
  const p = stage.requestFullscreen ? stage.requestFullscreen() : null;
  Promise.resolve(p).then(() => { try { $("canvas").focus(); } catch (e) {} }).catch(() => {});
});

/* Arrow keys and Space scroll the page by default, which steals them from the
   game and slides the canvas out of view — that is why shooting (on the arrows)
   felt dead. While a ROM is loaded, cancel that default: the engine's own key
   handler still fires, so the keys reach it and the page stays put. */
window.addEventListener("keydown", (e) => {
  if (!loaded) return;
  const k = e.key;
  if (k === "ArrowUp" || k === "ArrowDown" || k === "ArrowLeft" || k === "ArrowRight" ||
      k === " " || k === "Spacebar") e.preventDefault();
}, { passive: false });

selectGame(selected);   // sets CONFIG.rom, the stage note and the Load button
