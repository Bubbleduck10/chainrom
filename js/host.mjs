/**
 * A host environment for an engine compiled to WebAssembly.
 *
 * I had been treating this as blocked on the engine existing, which was wrong.
 * A C program built with wasi-sdk talks to WASI preview 1 — a documented,
 * fixed interface — so the host can be written and tested now, and a real
 * engine plugs into it rather than the other way round.
 *
 * What makes this one unusual is the file system. There is no disk: the game's
 * data files are the bundle that came off the chain, held in memory, and
 * **read-only by construction**. A game that tries to write a save file gets
 * EROFS rather than a silent success, because the bytes it would be writing to
 * are a verified copy of something immutable. Pretending a write worked would
 * mean the engine believes it saved and the player later finds it did not.
 *
 * Everything here reads and writes the engine's linear memory directly, which
 * is the part worth being careful about. WebAssembly cannot address outside its
 * own memory, so a wild pointer cannot escape the sandbox — but it can still
 * name an offset past the end of the buffer, and an unchecked DataView access
 * throws a RangeError that surfaces as an opaque crash with no indication of
 * which call caused it. So every pointer is bounds-checked and every failure
 * returns a proper errno, the way the engine expects.
 */

/** WASI preview 1 error numbers, only those this host can actually return. */
export const ERRNO = {
  SUCCESS: 0, BADF: 8, EXIST: 20, FAULT: 21, INVAL: 28, IO: 29, ISDIR: 31,
  NOENT: 44, NOSYS: 52, NOTDIR: 54, NOTSUP: 58, PERM: 63, ROFS: 69, SPIPE: 70,
};

export const FILETYPE = { UNKNOWN: 0, CHARACTER_DEVICE: 2, DIRECTORY: 3, REGULAR_FILE: 4 };
const WHENCE = { SET: 0, CUR: 1, END: 2 };

/* The preopened directory the engine is handed. A wasi-sdk program asks for
   preopens at startup and resolves every path relative to one of them; without
   this it has no root to open anything against. */
const ROOT_FD = 3;
const ROOT_NAME = "/";

/**
 * @param {object} o
 * @param {Map<string,Uint8Array>} o.files  the ROM's data files
 * @param {function} [o.stdout]  called with each line the engine writes
 * @param {function} [o.stderr]
 * @param {function} [o.now]     milliseconds; injectable so tests are not timing-dependent
 * @param {function} [o.random]  fills a Uint8Array; injectable for determinism
 */
export function createHost({ files, stdout = () => {}, stderr = () => {},
                             now = () => Date.now(), random = null } = {}) {
  if (!(files instanceof Map)) throw new Error("createHost needs the ROM's files as a Map");

  let memory = null;
  const setMemory = (m) => { memory = m; };

  /**
   * The guard has to live here rather than only in `view()`, because most
   * calls bounds-check before they touch memory — so an unset memory surfaced
   * as a null dereference from inside `inBounds` instead of the message that
   * says what to do about it.
   */
  const requireMemory = () => {
    if (!memory) throw new Error("the host has no memory — call setMemory after instantiating");
    return memory;
  };
  const view = () => new DataView(requireMemory().buffer);
  const bytes = () => new Uint8Array(requireMemory().buffer);

  /** Every pointer the engine hands over is checked against the real buffer. */
  const inBounds = (ptr, len) =>
    ptr >= 0 && len >= 0 && ptr + len <= requireMemory().buffer.byteLength;

  const readString = (ptr, len) => {
    if (!inBounds(ptr, len)) return null;
    return new TextDecoder().decode(bytes().subarray(ptr, ptr + len));
  };

  /**
   * Normalise a path to the form the bundle uses.
   *
   * A game will ask for "./data/level1", "data/level1" and "/data/level1" at
   * different points and mean the same file. Resolving them differently is a
   * "file not found" for a file that is plainly there.
   */
  const normalise = (p) => {
    let s = String(p).replace(/\\/g, "/");
    while (s.startsWith("./")) s = s.slice(2);
    while (s.startsWith("/")) s = s.slice(1);
    return s;
  };

  const lookup = (p) => {
    const n = normalise(p);
    if (files.has(n)) return files.get(n);
    /* Case-insensitive fallback: 1990s games were written for DOS and ask for
       upper-case names that no longer match what is in the bundle. */
    const lower = n.toLowerCase();
    for (const [name, data] of files) if (name.toLowerCase() === lower) return data;
    return null;
  };

  /* fd table. 0,1,2 are the standard streams; 3 is the preopened root. */
  const fds = new Map();
  fds.set(0, { kind: "stdin" });
  fds.set(1, { kind: "stdout" });
  fds.set(2, { kind: "stderr" });
  fds.set(ROOT_FD, { kind: "dir", name: ROOT_NAME });
  let nextFd = 4;

  const lineBuf = { 1: "", 2: "" };
  const writeOut = (fd, chunk) => {
    const sink = fd === 1 ? stdout : stderr;
    lineBuf[fd] += new TextDecoder().decode(chunk);
    let i;
    while ((i = lineBuf[fd].indexOf("\n")) >= 0) {
      sink(lineBuf[fd].slice(0, i));
      lineBuf[fd] = lineBuf[fd].slice(i + 1);
    }
  };

  /** Walk an iovec array, calling `fn(bufPtr, bufLen)` for each entry. */
  const eachIovec = (ptr, count, fn) => {
    const dv = view();
    let total = 0;
    for (let i = 0; i < count; i++) {
      const base = ptr + i * 8;
      if (!inBounds(base, 8)) return -1;
      const buf = dv.getUint32(base, true);
      const len = dv.getUint32(base + 4, true);
      if (!inBounds(buf, len)) return -1;
      total += fn(buf, len);
    }
    return total;
  };

  const wasi = {
    /* ── files ──────────────────────────────────────────────────────── */

    path_open(dirfd, _dirflags, pathPtr, pathLen, oflags, _rightsBase,
              _rightsInheriting, _fdflags, openedFdPtr) {
      const dir = fds.get(dirfd);
      if (!dir || dir.kind !== "dir") return ERRNO.BADF;
      const path = readString(pathPtr, pathLen);
      if (path === null) return ERRNO.FAULT;

      /* oflags bit 0 is O_CREAT. There is nothing to create on a read-only
         file system, and failing here is far better than letting the engine
         proceed believing it has an empty writable file. */
      if (oflags & 0x1) return ERRNO.ROFS;

      const data = lookup(path);
      if (!data) return ERRNO.NOENT;
      if (!inBounds(openedFdPtr, 4)) return ERRNO.FAULT;

      const fd = nextFd++;
      fds.set(fd, { kind: "file", name: normalise(path), data, pos: 0 });
      view().setUint32(openedFdPtr, fd, true);
      return ERRNO.SUCCESS;
    },

    fd_read(fd, iovsPtr, iovsLen, nreadPtr) {
      const f = fds.get(fd);
      if (!f) return ERRNO.BADF;
      if (f.kind === "stdin") {
        if (!inBounds(nreadPtr, 4)) return ERRNO.FAULT;
        view().setUint32(nreadPtr, 0, true);   // always at end of input
        return ERRNO.SUCCESS;
      }
      if (f.kind !== "file") return ERRNO.BADF;

      const read = eachIovec(iovsPtr, iovsLen, (buf, len) => {
        const take = Math.min(len, f.data.length - f.pos);
        if (take <= 0) return 0;
        bytes().set(f.data.subarray(f.pos, f.pos + take), buf);
        f.pos += take;
        return take;
      });
      if (read < 0) return ERRNO.FAULT;
      if (!inBounds(nreadPtr, 4)) return ERRNO.FAULT;
      view().setUint32(nreadPtr, read, true);
      return ERRNO.SUCCESS;
    },

    /** Positional read, which does not disturb the file offset. */
    fd_pread(fd, iovsPtr, iovsLen, offsetLo, nreadPtr) {
      const f = fds.get(fd);
      if (!f || f.kind !== "file") return ERRNO.BADF;
      let pos = Number(offsetLo);
      const read = eachIovec(iovsPtr, iovsLen, (buf, len) => {
        const take = Math.min(len, f.data.length - pos);
        if (take <= 0) return 0;
        bytes().set(f.data.subarray(pos, pos + take), buf);
        pos += take;
        return take;
      });
      if (read < 0) return ERRNO.FAULT;
      if (!inBounds(nreadPtr, 4)) return ERRNO.FAULT;
      view().setUint32(nreadPtr, read, true);
      return ERRNO.SUCCESS;
    },

    fd_seek(fd, offset, whence, newOffsetPtr) {
      const f = fds.get(fd);
      if (!f) return ERRNO.BADF;
      /* Seeking a pipe is meaningless and the engine needs to know that rather
         than receive a fabricated offset. */
      if (f.kind !== "file") return ERRNO.SPIPE;

      const delta = Number(offset);
      let next;
      if (whence === WHENCE.SET) next = delta;
      else if (whence === WHENCE.CUR) next = f.pos + delta;
      else if (whence === WHENCE.END) next = f.data.length + delta;
      else return ERRNO.INVAL;

      /* Seeking past the end is legal on a real file system; seeking before
         the start is not, and clamping it silently would hide a bug in the
         engine's own arithmetic. */
      if (next < 0) return ERRNO.INVAL;
      f.pos = next;
      if (!inBounds(newOffsetPtr, 8)) return ERRNO.FAULT;
      view().setBigUint64(newOffsetPtr, BigInt(next), true);
      return ERRNO.SUCCESS;
    },

    fd_tell(fd, offsetPtr) {
      const f = fds.get(fd);
      if (!f || f.kind !== "file") return ERRNO.SPIPE;
      if (!inBounds(offsetPtr, 8)) return ERRNO.FAULT;
      view().setBigUint64(offsetPtr, BigInt(f.pos), true);
      return ERRNO.SUCCESS;
    },

    fd_write(fd, iovsPtr, iovsLen, nwrittenPtr) {
      const f = fds.get(fd);
      if (!f) return ERRNO.BADF;
      /* Writing to the game's own data is refused. See the module header. */
      if (f.kind === "file") return ERRNO.ROFS;
      if (f.kind !== "stdout" && f.kind !== "stderr") return ERRNO.BADF;

      const written = eachIovec(iovsPtr, iovsLen, (buf, len) => {
        writeOut(f.kind === "stdout" ? 1 : 2, bytes().subarray(buf, buf + len));
        return len;
      });
      if (written < 0) return ERRNO.FAULT;
      if (!inBounds(nwrittenPtr, 4)) return ERRNO.FAULT;
      view().setUint32(nwrittenPtr, written, true);
      return ERRNO.SUCCESS;
    },

    fd_close(fd) {
      if (!fds.has(fd)) return ERRNO.BADF;
      if (fd <= ROOT_FD) return ERRNO.SUCCESS;   // the standard fds stay open
      fds.delete(fd);
      return ERRNO.SUCCESS;
    },

    /* ── metadata ───────────────────────────────────────────────────── */

    fd_fdstat_get(fd, statPtr) {
      const f = fds.get(fd);
      if (!f) return ERRNO.BADF;
      if (!inBounds(statPtr, 24)) return ERRNO.FAULT;
      const dv = view();
      const type = f.kind === "dir" ? FILETYPE.DIRECTORY
                 : f.kind === "file" ? FILETYPE.REGULAR_FILE
                 : FILETYPE.CHARACTER_DEVICE;
      dv.setUint8(statPtr, type);
      dv.setUint16(statPtr + 2, 0, true);                 // fs_flags
      dv.setBigUint64(statPtr + 8, 0xffffffffffffffffn, true);   // rights_base
      dv.setBigUint64(statPtr + 16, 0xffffffffffffffffn, true);  // rights_inheriting
      return ERRNO.SUCCESS;
    },

    fd_filestat_get(fd, bufPtr) {
      const f = fds.get(fd);
      if (!f) return ERRNO.BADF;
      if (!inBounds(bufPtr, 64)) return ERRNO.FAULT;
      const dv = view();
      const size = f.kind === "file" ? f.data.length : 0;
      dv.setBigUint64(bufPtr, 0n, true);                  // dev
      dv.setBigUint64(bufPtr + 8, 0n, true);              // ino
      dv.setUint8(bufPtr + 16, f.kind === "dir" ? FILETYPE.DIRECTORY
                             : f.kind === "file" ? FILETYPE.REGULAR_FILE
                             : FILETYPE.CHARACTER_DEVICE);
      dv.setBigUint64(bufPtr + 24, 1n, true);             // nlink
      dv.setBigUint64(bufPtr + 32, BigInt(size), true);   // size
      dv.setBigUint64(bufPtr + 40, 0n, true);             // atim
      dv.setBigUint64(bufPtr + 48, 0n, true);             // mtim
      dv.setBigUint64(bufPtr + 56, 0n, true);             // ctim
      return ERRNO.SUCCESS;
    },

    path_filestat_get(dirfd, _flags, pathPtr, pathLen, bufPtr) {
      const dir = fds.get(dirfd);
      if (!dir || dir.kind !== "dir") return ERRNO.BADF;
      const path = readString(pathPtr, pathLen);
      if (path === null) return ERRNO.FAULT;
      const data = lookup(path);
      if (!data) return ERRNO.NOENT;
      if (!inBounds(bufPtr, 64)) return ERRNO.FAULT;
      const dv = view();
      dv.setBigUint64(bufPtr, 0n, true);
      dv.setBigUint64(bufPtr + 8, 0n, true);
      dv.setUint8(bufPtr + 16, FILETYPE.REGULAR_FILE);
      dv.setBigUint64(bufPtr + 24, 1n, true);
      dv.setBigUint64(bufPtr + 32, BigInt(data.length), true);
      dv.setBigUint64(bufPtr + 40, 0n, true);
      dv.setBigUint64(bufPtr + 48, 0n, true);
      dv.setBigUint64(bufPtr + 56, 0n, true);
      return ERRNO.SUCCESS;
    },

    /* ── preopens ───────────────────────────────────────────────────── */

    fd_prestat_get(fd, prestatPtr) {
      /* Returning BADF for anything that is not the root is how the engine
         learns where the preopen list ends; it enumerates upward until this
         fails. Returning SUCCESS for unknown fds makes it loop forever. */
      if (fd !== ROOT_FD) return ERRNO.BADF;
      if (!inBounds(prestatPtr, 8)) return ERRNO.FAULT;
      const dv = view();
      dv.setUint8(prestatPtr, 0);                                  // tag: dir
      dv.setUint32(prestatPtr + 4, ROOT_NAME.length, true);
      return ERRNO.SUCCESS;
    },

    fd_prestat_dir_name(fd, pathPtr, pathLen) {
      if (fd !== ROOT_FD) return ERRNO.BADF;
      if (pathLen < ROOT_NAME.length) return ERRNO.INVAL;
      if (!inBounds(pathPtr, ROOT_NAME.length)) return ERRNO.FAULT;
      bytes().set(new TextEncoder().encode(ROOT_NAME), pathPtr);
      return ERRNO.SUCCESS;
    },

    /* ── environment ────────────────────────────────────────────────── */

    args_sizes_get(countPtr, sizePtr) {
      if (!inBounds(countPtr, 4) || !inBounds(sizePtr, 4)) return ERRNO.FAULT;
      const dv = view();
      dv.setUint32(countPtr, 0, true);
      dv.setUint32(sizePtr, 0, true);
      return ERRNO.SUCCESS;
    },
    args_get() { return ERRNO.SUCCESS; },
    environ_sizes_get(countPtr, sizePtr) {
      if (!inBounds(countPtr, 4) || !inBounds(sizePtr, 4)) return ERRNO.FAULT;
      const dv = view();
      dv.setUint32(countPtr, 0, true);
      dv.setUint32(sizePtr, 0, true);
      return ERRNO.SUCCESS;
    },
    environ_get() { return ERRNO.SUCCESS; },

    clock_time_get(_id, _precision, timePtr) {
      if (!inBounds(timePtr, 8)) return ERRNO.FAULT;
      /* WASI wants nanoseconds. Returning milliseconds here makes a game run
         a million times too fast, which reads as "the engine is broken". */
      view().setBigUint64(timePtr, BigInt(Math.round(now() * 1e6)), true);
      return ERRNO.SUCCESS;
    },

    random_get(bufPtr, len) {
      if (!inBounds(bufPtr, len)) return ERRNO.FAULT;
      const target = bytes().subarray(bufPtr, bufPtr + len);
      if (random) random(target);
      else if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(target);
      else for (let i = 0; i < len; i++) target[i] = (Math.random() * 256) | 0;
      return ERRNO.SUCCESS;
    },

    proc_exit(code) {
      /* Thrown rather than returned: the engine's `_start` must not continue
         past exit, and WASI has no way to say "stop" through a return value. */
      const e = new Error("the engine exited with code " + code);
      e.exitCode = code;
      e.wasiExit = true;
      throw e;
    },

    /* Anything a game asks for that this host does not implement should say so
       rather than return SUCCESS and leave the engine acting on a result that
       was never produced. */
    fd_fdstat_set_flags() { return ERRNO.NOSYS; },
    fd_advise() { return ERRNO.SUCCESS; },
    fd_datasync() { return ERRNO.ROFS; },
    fd_sync() { return ERRNO.ROFS; },
    path_create_directory() { return ERRNO.ROFS; },
    path_remove_directory() { return ERRNO.ROFS; },
    path_unlink_file() { return ERRNO.ROFS; },
    path_rename() { return ERRNO.ROFS; },
    fd_pwrite() { return ERRNO.ROFS; },
    sched_yield() { return ERRNO.SUCCESS; },
  };

  return {
    imports: { wasi_snapshot_preview1: wasi },
    setMemory,
    /* Exposed for tests and for a host that wants to inspect state. */
    _fds: fds,
    _lookup: lookup,
  };
}
