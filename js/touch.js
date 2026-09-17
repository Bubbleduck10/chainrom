/**
 * On-screen touch controls for the ROM games (DEPTH, SIEGE).
 *
 * The games are emscripten/SDL2 builds sealed on chain — their binaries can't be
 * changed, and they read a real keyboard (bound to the DOM) plus, for aiming, the
 * mouse on the `#canvas` element. So mobile support is done entirely in the page:
 * thumb sticks and buttons that SYNTHESISE the exact keyboard/mouse events the
 * engine already listens for. No engine change, no new ROM.
 *
 *   DEPTH  — left stick: WASD move (W/S forward-back, A/D strafe);
 *            right stick: turn (← →); RUN toggles Shift.
 *   SIEGE  — left stick: WASD move; right stick: 8-way fire (arrow keys);
 *            a tap is synthesised on mount because SIEGE starts on a click.
 */

/* physical-key specs the SDL html5 handler understands (code + key are what
   modern SDL2 reads; keyCode/which are patched on for older glue). */
const K = {
  W: { key: "w", code: "KeyW", keyCode: 87 },
  A: { key: "a", code: "KeyA", keyCode: 65 },
  S: { key: "s", code: "KeyS", keyCode: 83 },
  D: { key: "d", code: "KeyD", keyCode: 68 },
  Q: { key: "q", code: "KeyQ", keyCode: 81 },
  E: { key: "e", code: "KeyE", keyCode: 69 },
  Up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  Down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  Left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  Right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  Shift: { key: "Shift", code: "ShiftLeft", keyCode: 16 },
};

export const isTouch = () =>
  new URLSearchParams(location.search).get("touch") === "1" ||
  (typeof window !== "undefined" &&
    (("ontouchstart" in window) || navigator.maxTouchPoints > 0 || matchMedia("(pointer: coarse)").matches));

let root = null;      // the overlay element
let canvas = null;

function keyEvent(type, spec) {
  const e = new KeyboardEvent(type, { key: spec.key, code: spec.code, bubbles: true, cancelable: true, composed: true });
  // keyCode/which aren't honoured by the constructor; patch them for old glue.
  try { Object.defineProperty(e, "keyCode", { get: () => spec.keyCode }); Object.defineProperty(e, "which", { get: () => spec.keyCode }); } catch (_) {}
  // dispatch on the canvas; bubbling carries it to document and window, so the
  // engine gets it wherever SDL attached its listener.
  (canvas || document).dispatchEvent(e);
}

function mouseEvent(type, fx, fy) {
  if (!canvas) return;
  const r = canvas.getBoundingClientRect();
  const e = new MouseEvent(type, {
    clientX: r.left + r.width * fx, clientY: r.top + r.height * fy,
    button: 0, buttons: type === "mousedown" ? 1 : 0, bubbles: true, cancelable: true, view: window,
  });
  canvas.dispatchEvent(e);
}

/* A held-key set that only emits a keydown on press and a keyup on release, so
   the engine sees clean edges rather than a storm of repeats. */
function holder() {
  const held = new Set();
  return {
    set(keys) {
      for (const k of [...held]) if (!keys.includes(k)) { keyEvent("keyup", K[k]); held.delete(k); }
      for (const k of keys) if (!held.has(k)) { keyEvent("keydown", K[k]); held.add(k); }
    },
    clear() { for (const k of [...held]) { keyEvent("keyup", K[k]); } held.clear(); },
  };
}

const DZ = 0.32; // stick deadzone

/* Map a normalised stick vector to a set of direction keys. `mode`:
   "wasd"   → W/S forward-back + A/D (DEPTH: A/D strafe; SIEGE: A/D move),
   "arrows" → arrow keys (SIEGE 8-way fire),
   "turnQE" → Q/E only, horizontal (DEPTH turns on Q/E, per the sealed ROM). */
function vecKeys(nx, ny, mode) {
  const keys = [];
  if (mode === "turnQE") {
    if (nx < -DZ) keys.push("Q"); else if (nx > DZ) keys.push("E");
    return keys;
  }
  const up = mode === "arrows" ? "Up" : "W", down = mode === "arrows" ? "Down" : "S";
  const left = mode === "arrows" ? "Left" : "A", right = mode === "arrows" ? "Right" : "D";
  if (ny < -DZ) keys.push(up); else if (ny > DZ) keys.push(down);
  if (nx < -DZ) keys.push(left); else if (nx > DZ) keys.push(right);
  return keys;
}

/* Wire a stick element: track one touch (by identifier) from start to release,
   report a clamped unit vector, and animate the nub. */
function bindStick(el, onVec) {
  const nub = el.querySelector(".tnub");
  let pid = null, cx = 0, cy = 0, R = 1;
  const at = (touches) => { for (const t of touches) if (t.identifier === pid) return t; return null; };
  function begin(t) {
    const r = el.getBoundingClientRect();
    cx = r.left + r.width / 2; cy = r.top + r.height / 2; R = r.width / 2;
    update(t);
  }
  function update(t) {
    let dx = (t.clientX - cx) / R, dy = (t.clientY - cy) / R;
    const m = Math.hypot(dx, dy); if (m > 1) { dx /= m; dy /= m; }
    nub.style.transform = `translate(${dx * R * 0.55}px, ${dy * R * 0.55}px)`;
    onVec(dx, dy);
  }
  function release() { pid = null; nub.style.transform = "translate(0,0)"; onVec(0, 0); }

  el.addEventListener("touchstart", (e) => {
    e.preventDefault();
    if (pid !== null) return;
    const t = e.changedTouches[0]; pid = t.identifier; begin(t);
  }, { passive: false });
  window.addEventListener("touchmove", (e) => {
    if (pid === null) return; const t = at(e.changedTouches); if (t) { e.preventDefault(); update(t); }
  }, { passive: false });
  window.addEventListener("touchend", (e) => { if (pid !== null && at(e.changedTouches)) release(); });
  window.addEventListener("touchcancel", (e) => { if (pid !== null && at(e.changedTouches)) release(); });

  // mouse fallback for desktop testing with ?touch=1
  el.addEventListener("mousedown", (e) => { e.preventDefault(); pid = "m"; begin(e); });
  window.addEventListener("mousemove", (e) => { if (pid === "m") update(e); });
  window.addEventListener("mouseup", () => { if (pid === "m") release(); });
}

/* Wire a hold button: keydown while pressed, keyup on release. */
function bindHold(el, spec) {
  const down = (e) => { e.preventDefault(); el.classList.add("on"); keyEvent("keydown", spec); };
  const up = (e) => { e.preventDefault(); el.classList.remove("on"); keyEvent("keyup", spec); };
  el.addEventListener("touchstart", down, { passive: false });
  el.addEventListener("touchend", up); el.addEventListener("touchcancel", up);
  el.addEventListener("mousedown", down); window.addEventListener("mouseup", () => el.classList.contains("on") && up({ preventDefault() {} }));
}

/* Wire a latching toggle (Shift/run): tap on, tap off. */
function bindToggle(el, spec) {
  let on = false;
  const flip = (e) => { e.preventDefault(); on = !on; el.classList.toggle("on", on); keyEvent(on ? "keydown" : "keyup", spec); };
  el.addEventListener("touchstart", flip, { passive: false });
  el.addEventListener("mousedown", flip);
}

const SCHEMES = {
  depth: { move: "wasd", right: "turn", run: true, start: false },
  siege: { move: "wasd", right: "shoot", run: false, start: true },
};

export function mountTouch(gameId) {
  const scheme = SCHEMES[gameId];
  if (!scheme || !isTouch()) return;
  unmountTouch();
  canvas = document.getElementById("canvas");
  const stage = document.querySelector(".stage");
  if (!stage || !canvas) return;

  root = document.createElement("div");
  root.className = "touch";
  root.innerHTML = `
    <div class="tstick left" id="tMove"><i class="tnub"></i><span class="tcap">MOVE</span></div>
    <div class="tside">
      ${scheme.run ? '<button class="tbtn" id="tRun" type="button">RUN</button>' : ""}
      ${scheme.right === "turn"
        ? '<div class="tstick" id="tRight"><i class="tnub"></i><span class="tcap">TURN</span></div>'
        : '<div class="tstick" id="tRight"><i class="tnub"></i><span class="tcap">FIRE</span></div>'}
    </div>`;
  stage.appendChild(root);

  const move = holder();
  bindStick(root.querySelector("#tMove"), (nx, ny) => move.set(vecKeys(nx, ny, scheme.move)));

  const right = holder();
  const rmode = scheme.right === "turn" ? "turnQE" : "arrows";
  bindStick(root.querySelector("#tRight"), (nx, ny) => right.set(vecKeys(nx, ny, rmode)));

  if (scheme.run) bindToggle(root.querySelector("#tRun"), K.Shift);

  // SIEGE begins on a click — synthesise one over the field once the engine is up.
  if (scheme.start) {
    setTimeout(() => { mouseEvent("mousemove", 0.5, 0.5); mouseEvent("mousedown", 0.5, 0.5); setTimeout(() => mouseEvent("mouseup", 0.5, 0.5), 60); }, 600);
  }
}

export function unmountTouch() {
  if (root && root.parentNode) root.parentNode.removeChild(root);
  root = null;
}
