/**
 * Booting an emscripten-built engine out of chain state.
 *
 * A real 1990s game does not compile to bare WebAssembly. It compiles to a
 * wasm module *plus* a JavaScript runtime — the glue that provides its C
 * library, its filesystem, its SDL surface and its main loop. So a ROM holding
 * a real engine holds both, and booting it means running the glue.
 *
 * Which is the honest shape of this idea rather than a compromise: the
 * competing Solana project says the same thing about its own payload — even
 * the boot script comes off the chain. The page ships a reader, and everything
 * the reader runs is fetched and proved first.
 *
 * ── The thing to be clear-eyed about ──────────────────────────────────────
 *
 * This executes JavaScript that came from a chain. That is the premise, not an
 * oversight, and exactly one thing makes it defensible: the bytes have already
 * been rebuilt into a merkle tree and matched against the root the ROM
 * contract sealed. Code whose hash does not match never reaches here.
 *
 * So the ordering is not negotiable. `loadRom` verifies, and only then does
 * anything in this file run. Reversing that — importing first and checking
 * afterwards — would mean a hostile RPC gets its JavaScript executed regardless
 * of whether it was ever published.
 *
 * ── Why Blob URLs ────────────────────────────────────────────────────────
 *
 * The glue is an ES module and the wasm is fetched by URL. Neither exists as a
 * file anywhere: they are bytes in memory. A Blob URL is how you hand in-memory
 * bytes to `import()` and to emscripten's own `locateFile` without inventing a
 * server to serve them from.
 */

/** Does this bundle look like emscripten output rather than a bare module? */
export function isEmscriptenBundle(files) {
  let js = null, wasm = null;
  for (const [name] of files) {
    if (name.toLowerCase().endsWith(".js")) js = name;
    else if (name.toLowerCase().endsWith(".wasm")) wasm = name;
  }
  return Boolean(js && wasm);
}

/** Split a bundle into glue, module, and everything the game will read. */
export function splitEmscripten(files) {
  let glue = null, wasm = null;
  const data = new Map();
  for (const [name, bytes] of files) {
    const low = name.toLowerCase();
    if (!glue && low.endsWith(".js")) glue = { name, bytes };
    else if (!wasm && low.endsWith(".wasm")) wasm = { name, bytes };
    else data.set(name, bytes);
  }
  if (!glue) throw new Error("no JavaScript runtime in this ROM");
  if (!wasm) throw new Error("no .wasm in this ROM");
  return { glue, wasm, data };
}

/**
 * Write the ROM's data files into the engine's in-memory filesystem.
 *
 * Emscripten's FS starts empty because nothing was preloaded at build time —
 * the game's data lives on a chain, not next to the binary. Directories have to
 * be created before their files, and the paths are flattened to the working
 * directory because a DOS-era engine looks for its data beside the executable,
 * not under a tree.
 */
export function stageFiles(FS, data, { flatten = true } = {}) {
  const written = [];
  for (const [name, bytes] of data) {
    const target = flatten ? name.split("/").pop() : name;
    if (!flatten) {
      const parts = target.split("/").slice(0, -1);
      let dir = "";
      for (const p of parts) {
        dir += "/" + p;
        try { FS.mkdir(dir); } catch { /* already there */ }
      }
    }
    FS.writeFile("/" + target, bytes);
    written.push(target);
  }
  return written;
}

/**
 * Boot an emscripten engine from verified bytes.
 *
 * @param {object} o
 * @param {Map} o.files      the verified bundle
 * @param {HTMLCanvasElement} o.canvas
 * @param {function} [o.onOutput]  stdout/stderr from the engine
 * @param {string[]} [o.args]      argv for main()
 */
export async function bootEmscripten({ files, canvas, onOutput = () => {},
                                       args = [], onStage = () => {} } = {}) {
  const { glue, wasm, data } = splitEmscripten(files);

  /* Both get Blob URLs. The wasm one is handed back through `locateFile`,
     which is how emscripten asks "where do I fetch my module from" — and the
     answer here is "from memory, you already have it". */
  const wasmUrl = URL.createObjectURL(new Blob([wasm.bytes], { type: "application/wasm" }));
  const glueUrl = URL.createObjectURL(new Blob([glue.bytes], { type: "text/javascript" }));

  let factory;
  try {
    const mod = await import(/* @vite-ignore */ glueUrl);
    factory = mod.default;
    if (typeof factory !== "function") {
      throw new Error("the runtime did not export a module factory — it needs " +
                      "building with -sMODULARIZE -sEXPORT_ES6");
    }
  } finally {
    /* Revoked as soon as the import resolves; the module object outlives the
       URL, and leaving it live pins the blob in memory for the session. */
    URL.revokeObjectURL(glueUrl);
  }

  let staged = [];
  const instance = await factory({
    canvas,
    arguments: args,
    locateFile: (p) => (p.endsWith(".wasm") ? wasmUrl : p),
    print: (t) => onOutput(t, "out"),
    printErr: (t) => onOutput(t, "err"),
    preRun: [
      /**
       * The Module arrives as the first argument.
       *
       * Emscripten dispatches these as `callbacks.shift()(Module)`, so a
       * callback written to use `this` gets `undefined` — the glue is an ES
       * module and therefore strict mode, where an unbound call has no
       * receiver. It surfaces as "cannot read properties of undefined
       * (reading 'FS')" at the moment the data would have been staged.
       *
       * Staging happens here because the engine opens its data files during
       * main(); writing them afterwards is too late, and the game reports
       * missing files that are demonstrably present on the chain.
       */
      (mod) => {
        staged = stageFiles(mod.FS, data);
        onStage(staged);
      },
    ],
  });

  URL.revokeObjectURL(wasmUrl);
  return { instance, staged, glueName: glue.name, wasmName: wasm.name };
}

/**
 * Start the game.
 *
 * Kept separate from booting so a caller can inspect the filesystem, report
 * what was staged, and fail with something useful *before* handing control to
 * a main loop that never returns.
 */
export function start(instance, args = []) {
  if (typeof instance.callMain !== "function") {
    throw new Error("this runtime has no callMain — it needs building with -sINVOKE_RUN=0");
  }
  return instance.callMain(args);
}
