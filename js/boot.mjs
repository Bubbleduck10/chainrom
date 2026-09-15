/**
 * Turn the bytes read off a chain into a running program.
 *
 * The chain gives back one verified byte string. This unpacks it into files,
 * finds the engine, and instantiates it — in the browser and in Node, because
 * `WebAssembly` is in both and the test suite should boot the same way the page
 * does.
 *
 * What this deliberately does *not* do is pretend to know a particular engine's
 * interface. A compiled 1990s game expects some host environment — a file
 * system, a frame buffer, a clock — and the shape of that is the engine's
 * business, not the loader's. So imports are supplied by the caller and the
 * data files are handed over as a Map. The seam is explicit rather than a
 * half-guessed emulation layer that would have to be rewritten the moment a
 * real engine arrived.
 *
 * The one thing worth being firm about: the WebAssembly is compiled *after*
 * the ROM's hashes have been checked, never before. Compiling first and
 * verifying afterwards would mean a hostile RPC gets its bytes through the
 * compiler regardless of whether they were the published ones.
 */
import { openBundle, findEngine } from "./bundle.mjs";

/**
 * Unpack a verified ROM payload into its files.
 *
 * `loadRom` has already proved these bytes are the published ones. This proves
 * they are a well-formed bundle, which is a separate question — a publisher can
 * commit to a malformed bundle exactly as easily as a good one.
 */
export function openRom(bytes) {
  const files = openBundle(bytes);
  const engine = findEngine(files);
  const data = new Map([...files].filter(([name]) => name !== engine.name));
  return { files, engine, data };
}

/**
 * Compile and instantiate the engine.
 *
 * @param {object} o
 * @param {Uint8Array} o.bytes   the verified ROM payload
 * @param {object} [o.imports]   the host environment the engine expects
 * @param {function} [o.onFiles] called with the data files before instantiation,
 *                               so a host can stage them wherever the engine
 *                               will look for them
 */
/** The `env` names that mean an engine wants the framebuffer bridge. */
const SCREEN_IMPORTS = new Set(["present", "set_palette", "poll_event", "now_ms"]);

export async function bootRom({ bytes, imports = {}, onFiles, wasi = true,
                                screen, canvas = null, stdout, stderr } = {}) {
  const { files, engine, data } = openRom(bytes);
  if (onFiles) await onFiles(data);

  let host = null, display = null;

  let module;
  try {
    module = await WebAssembly.compile(engine.bytes);
  } catch (e) {
    /* A compile failure here is worth naming precisely: the bytes matched the
       chain's root, so the ROM is intact and the problem is the payload that
       was published, not the delivery of it. */
    throw new Error("the ROM is intact but its engine will not compile: " + e.message);
  }

  /* Report what the engine actually wants, so a missing import is a sentence
     rather than a LinkError naming one field at a time. */
  const wanted = WebAssembly.Module.imports(module);

  /* A game built with wasi-sdk asks for `wasi_snapshot_preview1`, and the host
     for it can be assembled from what is already here: the bundle's data files
     *are* the file system. Built only when the engine actually asks for it —
     an earlier version created it unconditionally and then demanded an
     exported memory from modules that had never heard of WASI. Pass
     `wasi: false` for an engine that ships its own glue. */
  if (wasi && !imports.wasi_snapshot_preview1 &&
      wanted.some((w) => w.module === "wasi_snapshot_preview1")) {
    const { createHost } = await import("./host.mjs");
    host = createHost({ files: data, stdout, stderr });
    imports = { ...imports, ...host.imports };
  }

  /* The framebuffer, on the same terms: supplied only if the engine asks for
     it, and merged into whatever `env` the caller already provided rather than
     replacing it — an engine wanting both `present` and its own `env` helper
     would otherwise lose one of them at link time. */
  if (screen === undefined || screen) {
    const usesScreen = wanted.some((w) => w.module === "env" && SCREEN_IMPORTS.has(w.name));
    if (usesScreen) {
      const { createScreen } = await import("./screen.mjs");
      display = createScreen({ canvas });
      imports = { ...imports, env: { ...display.imports.env, ...(imports.env || {}) } };
    }
  }
  const missing = wanted.filter((w) => {
    const mod = imports[w.module];
    return !mod || !(w.name in mod);
  });
  if (missing.length) {
    throw new Error("engine needs imports that were not supplied: " +
      missing.map((m) => m.module + "." + m.name).join(", "));
  }

  const instance = await WebAssembly.instantiate(module, imports);

  /* The host needs the engine's memory, and the engine only has one after it
     is instantiated — so this wiring cannot happen any earlier. Skipping it
     leaves every host call dereferencing null on the engine's first file read,
     which looks like a loader bug rather than a missing step. */
  if (host || display) {
    if (!instance.exports.memory) {
      throw new Error("the engine imports a host interface but exports no memory — " +
                      "the host cannot read or write its address space");
    }
    if (host) host.setMemory(instance.exports.memory);
    if (display) display.setMemory(instance.exports.memory);
  }

  return { files, data, module, instance, host, display, engineName: engine.name };
}

/**
 * What the engine offers, for wiring a host to an unfamiliar build.
 *
 * A compiled game rarely documents its own entry point, and guessing wrong
 * produces silence rather than an error. Listing the exports is the fastest way
 * to find the one that starts it.
 */
export function describe({ module, instance }) {
  return {
    imports: WebAssembly.Module.imports(module).map((i) => i.module + "." + i.name),
    exports: WebAssembly.Module.exports(module).map((e) => e.kind + " " + e.name),
    memoryPages: instance.exports.memory ? instance.exports.memory.buffer.byteLength / 65536 : 0,
  };
}
