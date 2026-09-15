/**
 * Pixels out of the engine's memory and onto a canvas, and keys back in.
 *
 * A compiled game draws into its own linear memory and then tells the host a
 * frame is ready. Everything here is the other side of that: read the bytes at
 * the pointer it names, convert them to RGBA, and blit. Input goes the other
 * way through a small queue the engine polls, because a 1990s main loop asks
 * for input when it is ready rather than being interrupted.
 *
 * Two conversions carry almost all the risk, and both fail by producing a
 * picture rather than an error:
 *
 *   VGA palettes are 6-bit. A DOS-era palette stores each channel as 0–63,
 *   not 0–255. Copying those values straight into RGBA gives a picture that is
 *   exactly four times too dark — perfectly recognisable, obviously wrong, and
 *   with nothing anywhere to say why. The palette setter detects the range and
 *   scales, and says which it chose.
 *
 *   Row stride is not always width. An engine may render into a buffer wider
 *   than the visible area. Assuming stride equals width shears the image
 *   diagonally, which looks like a corrupted payload rather than a wrong
 *   multiplication.
 *
 * No DOM is required to construct this, so the conversion logic is tested
 * directly rather than through a browser.
 */

export const FORMAT = { INDEXED8: 0, RGBA8888: 1, RGB565: 2 };

export const EVENT = { NONE: 0, KEY_DOWN: 1, KEY_UP: 2 };

/**
 * A small, deliberately boring key mapping.
 *
 * Engines expect their own scancodes and a real build will need a table that
 * matches it. What matters here is that the mapping is *explicit* — a pass-
 * through of browser key codes would silently differ between keyboard layouts,
 * and the bug would look like "the arrow keys do not work on some machines".
 */
export const KEYS = {
  ArrowUp: 1, ArrowDown: 2, ArrowLeft: 3, ArrowRight: 4,
  ControlLeft: 5, ControlRight: 5, Space: 6, Enter: 7, Escape: 8,
  AltLeft: 9, AltRight: 9, ShiftLeft: 10, ShiftRight: 10, Tab: 11,
};

export function createScreen({ canvas = null, width = 320, height = 200,
                               maxQueue = 64, now = () => performance.now() } = {}) {
  let memory = null;
  let ctx = null, image = null;
  let w = width, h = height;
  let palette = new Uint8Array(256 * 4);
  let paletteScaled = null;
  let frames = 0;

  /* Default palette is opaque greyscale, so a game that presents before
     setting a palette shows something legible rather than a black rectangle
     that is indistinguishable from "nothing happened". */
  for (let i = 0; i < 256; i++) {
    palette[i * 4] = palette[i * 4 + 1] = palette[i * 4 + 2] = i;
    palette[i * 4 + 3] = 255;
  }

  const queue = [];

  const attach = (el) => {
    canvas = el;
    ctx = null; image = null;
  };
  const setMemory = (m) => { memory = m; };

  const ensureSurface = (nw, nh) => {
    if (!canvas) return false;
    if (!ctx) ctx = canvas.getContext("2d");
    if (!ctx) return false;
    if (!image || w !== nw || h !== nh) {
      w = nw; h = nh;
      canvas.width = nw; canvas.height = nh;
      image = ctx.createImageData(nw, nh);
    }
    return true;
  };

  const requireMemory = () => {
    if (!memory) throw new Error("the screen has no memory — call setMemory after instantiating");
    return memory;
  };

  /**
   * Convert a frame from the engine's memory into RGBA.
   *
   * Exported separately from `present` so the maths can be tested without a
   * canvas, which is where every one of the traps above actually lives.
   */
  function convert(src, nw, nh, format, stride) {
    const rowBytes = stride || nw * (format === FORMAT.INDEXED8 ? 1
                                   : format === FORMAT.RGB565 ? 2 : 4);
    const out = new Uint8ClampedArray(nw * nh * 4);
    const pal = paletteScaled || palette;

    for (let y = 0; y < nh; y++) {
      const row = y * rowBytes;
      let o = y * nw * 4;
      if (format === FORMAT.INDEXED8) {
        for (let x = 0; x < nw; x++) {
          const idx = src[row + x] * 4;
          out[o++] = pal[idx]; out[o++] = pal[idx + 1];
          out[o++] = pal[idx + 2]; out[o++] = 255;
        }
      } else if (format === FORMAT.RGBA8888) {
        for (let x = 0; x < nw; x++) {
          const p = row + x * 4;
          out[o++] = src[p]; out[o++] = src[p + 1];
          out[o++] = src[p + 2]; out[o++] = 255;
        }
      } else if (format === FORMAT.RGB565) {
        for (let x = 0; x < nw; x++) {
          const p = row + x * 2;
          const v = src[p] | (src[p + 1] << 8);
          /* Replicating the high bits into the low ones keeps white at 255
             rather than 248 — a plain shift leaves the brightest pixels
             visibly grey. */
          const r = (v >> 11) & 0x1f, g = (v >> 5) & 0x3f, b = v & 0x1f;
          out[o++] = (r << 3) | (r >> 2);
          out[o++] = (g << 2) | (g >> 4);
          out[o++] = (b << 3) | (b >> 2);
          out[o++] = 255;
        }
      } else {
        throw new Error("unknown pixel format " + format);
      }
    }
    return out;
  }

  /**
   * Load a palette of `count` RGB triples.
   *
   * Returns which range it detected, so a host can report it rather than
   * leaving "the picture is dark" to be puzzled over.
   */
  function loadPalette(src, count = 256) {
    let max = 0;
    for (let i = 0; i < count * 3; i++) if (src[i] > max) max = src[i];
    /* 6-bit VGA palettes never exceed 63. Anything above that is already
       8-bit, and scaling it would blow out the highlights instead. */
    const sixBit = max <= 63;
    const next = new Uint8Array(256 * 4);
    for (let i = 0; i < count; i++) {
      const s = i * 3, d = i * 4;
      next[d] = sixBit ? (src[s] << 2) | (src[s] >> 4) : src[s];
      next[d + 1] = sixBit ? (src[s + 1] << 2) | (src[s + 1] >> 4) : src[s + 1];
      next[d + 2] = sixBit ? (src[s + 2] << 2) | (src[s + 2] >> 4) : src[s + 2];
      next[d + 3] = 255;
    }
    palette = next;
    paletteScaled = null;
    return { sixBit, max };
  }

  /** Queue a key event for the engine to collect on its next poll. */
  function pushKey(type, code) {
    const mapped = KEYS[code];
    if (mapped === undefined) return false;
    /* Bounded: a key held during a stall would otherwise grow this without
       limit and the engine would work through a minute of stale input once it
       resumed. Dropping the oldest keeps the queue current. */
    if (queue.length >= maxQueue) queue.shift();
    queue.push(((type & 0xff) << 24) | (mapped & 0xffffff));
    return true;
  }

  /** Attach real keyboard handlers. Returns a function that detaches them. */
  function listen(target = globalThis) {
    if (!target.addEventListener) return () => {};
    const down = (e) => { if (pushKey(EVENT.KEY_DOWN, e.code)) e.preventDefault(); };
    const up = (e) => { if (pushKey(EVENT.KEY_UP, e.code)) e.preventDefault(); };
    target.addEventListener("keydown", down);
    target.addEventListener("keyup", up);
    return () => {
      target.removeEventListener("keydown", down);
      target.removeEventListener("keyup", up);
    };
  }

  const env = {
    /**
     * The engine says a frame is ready at `ptr`.
     *
     * Bounds-checked like every other pointer: a frame that runs past the end
     * of memory must be refused, not truncated into a picture that is mostly
     * right.
     */
    present(ptr, nw, nh, format, stride = 0) {
      const mem = requireMemory();
      const bpp = format === FORMAT.INDEXED8 ? 1 : format === FORMAT.RGB565 ? 2 : 4;
      const need = (stride || nw * bpp) * nh;
      if (ptr < 0 || nw <= 0 || nh <= 0 || ptr + need > mem.buffer.byteLength) return -1;

      const src = new Uint8Array(mem.buffer, ptr, need);
      const rgba = convert(src, nw, nh, format, stride);
      frames++;
      if (!ensureSurface(nw, nh)) return 0;   // no canvas attached; conversion still ran
      image.data.set(rgba);
      ctx.putImageData(image, 0, 0);
      return 0;
    },

    set_palette(ptr, count) {
      const mem = requireMemory();
      if (ptr < 0 || count < 0 || ptr + count * 3 > mem.buffer.byteLength) return -1;
      loadPalette(new Uint8Array(mem.buffer, ptr, count * 3), count);
      return 0;
    },

    /** Next queued event, or 0 when there is nothing. */
    poll_event() {
      return queue.length ? queue.shift() : EVENT.NONE;
    },

    now_ms() { return now(); },
  };

  return {
    imports: { env },
    attach, setMemory, listen, pushKey, loadPalette, convert,
    get frames() { return frames; },
    get queued() { return queue.length; },
    get palette() { return palette; },
  };
}
