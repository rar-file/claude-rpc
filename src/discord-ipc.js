// Minimal, dependency-free Discord Rich Presence IPC client.
//
// claude-rpc only ever needs *local presence* — connect to the Discord
// desktop client's IPC socket, set/clear an activity. It never touches
// Discord's REST API, OAuth, the gateway, or voice. `@xhayper/discord-rpc`
// (our former sole runtime dependency) shipped all of that plus undici, ws,
// and the @discordjs/* stack — ~10 transitive packages for a feature that is,
// on the wire, an 8-byte header and a JSON blob over a named pipe / unix
// socket. This module reimplements exactly the slice the daemon uses, so the
// published package has ZERO runtime dependencies.
//
// Wire protocol (unchanged Discord IPC):
//   frame  = <op:uint32 LE> <len:uint32 LE> <json utf8 of length len>
//   op 0 HANDSHAKE  · op 1 FRAME · op 2 CLOSE · op 3 PING · op 4 PONG
//   handshake  → { v: 1, client_id }
//   READY      ← { cmd:'DISPATCH', evt:'READY', data:{ user, config } }
//   request    → { cmd, args, nonce }   response matched back by nonce
//
// The activity-object → payload mapping below is a faithful copy of
// @xhayper's ClientUser.setActivity, so the rendered card is byte-identical
// to what shipped through v0.13.4.
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';

export const OP_HANDSHAKE = 0;
export const OP_FRAME = 1;
export const OP_CLOSE = 2;
export const OP_PING = 3;
export const OP_PONG = 4;

const CONNECT_TIMEOUT_MS = 10_000; // matches @xhayper's connect() timeout
// Per-candidate connect timeout: a socket file whose peer accepts then stalls
// must not wedge discovery of the real Discord socket behind it.
const SOCKET_CONNECT_TIMEOUT_MS = 1500;

// Same resolution order @xhayper used: XDG_RUNTIME_DIR → TMPDIR → TMP → TEMP → /tmp.
function getTempDir() {
  const { XDG_RUNTIME_DIR, TMPDIR, TMP, TEMP } = process.env;
  return fs.realpathSync(XDG_RUNTIME_DIR ?? TMPDIR ?? TMP ?? TEMP ?? `${path.sep}tmp`);
}

// Candidate IPC socket paths, mirroring @xhayper's defaultPathList.
//   win32: named pipe \\?\pipe\discord-ipc-{0..9} (no existence pre-check)
//   posix: <tmp>/discord-ipc-{0..9}, plus snap + flatpak subdirs on linux.
// On posix we only keep paths that actually exist, exactly like the library —
// connecting to a non-existent unix socket just wastes a syscall per id.
export function candidatePaths(platform = process.platform) {
  const out = [];
  if (platform === 'win32') {
    for (let i = 0; i < 10; i++) out.push(`\\\\?\\pipe\\discord-ipc-${i}`);
    return out;
  }
  let base;
  try {
    base = getTempDir();
  } catch {
    base = '/tmp';
  }
  const dirs = [base];
  if (platform === 'linux') {
    dirs.push(path.join(base, 'snap.discord'));
    dirs.push(path.join(base, 'app', 'com.discordapp.Discord'));
  }
  for (const dir of dirs) {
    for (let i = 0; i < 10; i++) {
      const p = path.join(dir, `discord-ipc-${i}`);
      if (fs.existsSync(p)) out.push(p);
    }
  }
  return out;
}

// Encode one IPC frame: 8-byte little-endian header + JSON body.
export function encodeFrame(op, data) {
  const body = data === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(data));
  const header = Buffer.alloc(8);
  header.writeUInt32LE(op, 0);
  header.writeUInt32LE(body.length, 4);
  return Buffer.concat([header, body]);
}

// Stateful decoder: feed it socket chunks, get back complete {op, data} frames.
// Handles partial reads and multiple frames coalesced into one chunk.
export function createFrameDecoder() {
  let buf = Buffer.alloc(0);
  return function push(chunk) {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    const frames = [];
    while (buf.length >= 8) {
      const op = buf.readUInt32LE(0);
      const len = buf.readUInt32LE(4);
      if (buf.length < 8 + len) break; // wait for the rest of the body
      const body = buf.subarray(8, 8 + len);
      buf = buf.subarray(8 + len);
      let data;
      try {
        data = body.length ? JSON.parse(body.toString()) : undefined;
      } catch {
        continue; // skip a malformed frame, keep draining the buffer
      }
      frames.push({ op, data });
    }
    return frames;
  };
}

// Friendly activity object → Discord's SET_ACTIVITY payload. Faithful copy of
// @xhayper ClientUser.setActivity (the subset claude-rpc uses). Kept verbatim
// so existing config renders identically.
export function formatActivity(activity = {}, pid) {
  const a = {
    name: activity.name,
    type: activity.type ?? 0, // 0 = Playing
    instance: !!activity.instance,
  };
  if (activity.type === 1 && activity.url) a.url = activity.url; // Streaming only
  if (activity.details) a.details = activity.details;
  if (activity.state) a.state = activity.state;

  if (activity.startTimestamp || activity.endTimestamp) {
    a.timestamps = {};
    const start = activity.startTimestamp instanceof Date ? activity.startTimestamp.getTime() : activity.startTimestamp;
    const end = activity.endTimestamp instanceof Date ? activity.endTimestamp.getTime() : activity.endTimestamp;
    if (typeof start === 'number') a.timestamps.start = start;
    if (typeof end === 'number') a.timestamps.end = end;
  }

  if (activity.largeImageKey || activity.smallImageKey || activity.largeImageText || activity.smallImageText) {
    a.assets = {};
    if (activity.largeImageKey) a.assets.large_image = activity.largeImageKey;
    if (activity.smallImageKey) a.assets.small_image = activity.smallImageKey;
    if (activity.largeImageText) a.assets.large_text = activity.largeImageText;
    if (activity.smallImageText) a.assets.small_text = activity.smallImageText;
  }

  // Party — renders natively as "(2 of 4)" on the card. Same field names
  // @xhayper used (partyId / partySize / partyMax); size requires both ends.
  if (activity.partyId || (activity.partySize != null && activity.partyMax != null)) {
    a.party = {};
    if (activity.partyId) a.party.id = activity.partyId;
    if (activity.partySize != null && activity.partyMax != null) {
      a.party.size = [activity.partySize, activity.partyMax];
    }
  }

  if (activity.buttons?.length) a.buttons = activity.buttons;

  return { pid: pid ?? process?.pid ?? 0, activity: a };
}

// Drop-in for the slice of @xhayper's `Client` the daemon relies on:
//   new Client({ clientId, transport:{ type:'ipc', pathList? } })
//   client.on('ready'|'disconnected', …) · await client.login()
//   client.user.{username, setActivity(a), clearActivity()} · client.destroy()
export class Client extends EventEmitter {
  constructor(options = {}) {
    super();
    this.clientId = options.clientId;
    // pathList override is used by tests to point at a fake server; production
    // leaves it undefined and we discover the real Discord socket.
    this._pathList = options.transport?.pathList;
    this.socket = null;
    this.user = null;
    this._pending = new Map(); // nonce → { resolve, reject }
    this._connected = false;
    this._decode = null;
  }

  async _openSocket() {
    const paths = this._pathList ?? candidatePaths();
    for (const p of paths) {
      const socket = await new Promise((resolve) => {
        const s = net.createConnection(p);
        let timer = null;
        const cleanup = () => {
          clearTimeout(timer);
          s.removeListener('connect', onOk);
          s.removeListener('error', onErr);
        };
        const onErr = () => { cleanup(); resolve(null); };
        const onOk = () => { cleanup(); resolve(s); };
        // A peer that accepts then stalls would otherwise never settle this
        // candidate and block the rest each discovery cycle (and leak the fd).
        timer = setTimeout(() => { cleanup(); s.destroy(); resolve(null); }, SOCKET_CONNECT_TIMEOUT_MS);
        if (typeof timer === 'object' && 'unref' in timer) timer.unref();
        s.once('connect', onOk);
        s.once('error', onErr);
      });
      if (socket) return socket;
    }
    return null;
  }

  // Connect, handshake, and resolve once Discord sends READY (which also
  // populates `user`). Mirrors @xhayper: login() with no scopes === connect().
  async login() {
    const socket = await this._openSocket();
    if (!socket) {
      const err = new Error('Could not connect to Discord client');
      err.code = 'ECONNREFUSED';
      throw err;
    }
    this.socket = socket;
    this._decode = createFrameDecoder();

    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const err = new Error('Connection timed out');
        err.code = 'ETIMEDOUT';
        reject(err);
      }, CONNECT_TIMEOUT_MS);
      if (typeof timer === 'object' && 'unref' in timer) timer.unref();
      this._readyResolve = () => {
        clearTimeout(timer);
        resolve();
      };
      this._readyReject = (e) => {
        clearTimeout(timer);
        reject(e);
      };
    });

    socket.on('data', (chunk) => this._onData(chunk));
    socket.on('close', () => this._onClose('Connection ended'));
    socket.on('error', () => this._onClose('socket error'));

    this._send(OP_HANDSHAKE, { v: 1, client_id: this.clientId });

    await ready;
    // No OAuth scopes are ever requested, so READY === ready, same as the lib.
    this.emit('ready');
  }

  _send(op, data) {
    if (!this.socket) return;
    try {
      this.socket.write(encodeFrame(op, data));
    } catch {
      // Broken pipe mid-write — the 'close'/'error' handler will drive the
      // daemon's reconnect. Swallow so a write race can't crash the process.
    }
  }

  // Send a command frame and resolve when the nonce-matched reply arrives.
  // Times out after 10s: on a half-open pipe Discord can ack the socket write
  // but never send the nonce reply, and without a deadline that await would
  // hang forever — freezing the daemon's presence on a stale frame, with the
  // watchdog blind because `connected` still reads true.
  request(cmd, args, timeoutMs = 10_000) {
    return new Promise((resolve, reject) => {
      if (!this.socket) {
        const err = new Error('Not connected');
        err.code = 'ENOTCONN';
        reject(err);
        return;
      }
      const nonce = randomUUID();
      const timer = setTimeout(() => {
        this._pending.delete(nonce);
        const err = new Error(`No reply to ${cmd} within ${timeoutMs}ms`);
        err.code = 'ETIMEDOUT';
        reject(err);
      }, timeoutMs);
      if (timer.unref) timer.unref();
      this._pending.set(nonce, { resolve, reject, timer });
      this._send(OP_FRAME, { cmd, args, nonce });
    });
  }

  _onData(chunk) {
    let frames;
    try {
      frames = this._decode(chunk);
    } catch {
      return;
    }
    for (const { op, data } of frames) this._onFrame(op, data);
  }

  _onFrame(op, msg) {
    if (op === OP_PING) {
      this._send(OP_PONG, msg);
      return;
    }
    if (op === OP_CLOSE) {
      this._onClose(msg);
      return;
    }
    if (op !== OP_FRAME || !msg) return;

    if (msg.cmd === 'DISPATCH' && msg.evt === 'READY') {
      this.user = this._buildUser(msg.data?.user || {});
      this._connected = true;
      if (this._readyResolve) this._readyResolve();
      return;
    }

    // Nonce-matched response to a request() (e.g. SET_ACTIVITY).
    if (msg.nonce && this._pending.has(msg.nonce)) {
      const { resolve, reject, timer } = this._pending.get(msg.nonce);
      clearTimeout(timer);
      this._pending.delete(msg.nonce);
      if (msg.evt === 'ERROR') {
        const err = new Error(msg.data?.message || 'Discord RPC error');
        err.code = msg.data?.code;
        reject(err);
      } else {
        resolve(msg);
      }
    }
  }

  // Wrap the READY user payload with the activity methods the daemon calls on
  // `client.user`. Spreading the raw fields preserves `.username` (and id, etc).
  _buildUser(raw) {
    return {
      ...raw,
      setActivity: (activity, pid) => this.request('SET_ACTIVITY', formatActivity(activity, pid)),
      clearActivity: (pid) => this.request('SET_ACTIVITY', { pid: pid ?? process?.pid ?? 0 }),
    };
  }

  _onClose(reason) {
    const wasConnected = this._connected || !!this.socket;
    // Fail any in-flight requests so awaiters don't hang forever.
    for (const { reject, timer } of this._pending.values()) {
      clearTimeout(timer);
      const err = new Error(typeof reason === 'string' ? reason : 'Connection closed');
      err.code = 'ECONNRESET';
      reject(err);
    }
    this._pending.clear();
    if (this._readyReject && !this._connected) {
      const err = new Error('Connection closed before ready');
      err.code = 'ECONNRESET';
      this._readyReject(err);
    }
    this._readyResolve = this._readyReject = null;
    this._teardownSocket();
    this._connected = false;
    if (wasConnected) this.emit('disconnected');
  }

  _teardownSocket() {
    if (!this.socket) return;
    try {
      this.socket.removeAllListeners();
      this.socket.destroy();
    } catch {
      // already gone
    }
    this.socket = null;
  }

  destroy() {
    // Best-effort close; don't emit 'disconnected' on an explicit teardown
    // (the daemon calls destroy() itself and manages its own reconnect).
    this._readyResolve = this._readyReject = null;
    // Reject in-flight requests (mirrors _onClose) — a pushPresence parked on
    // `await setActivity` when the watchdog tears the client down must settle,
    // not leak as a forever-pending promise.
    for (const { reject, timer } of this._pending.values()) {
      clearTimeout(timer);
      const err = new Error('Client destroyed');
      err.code = 'ECONNRESET';
      reject(err);
    }
    this._pending.clear();
    this._teardownSocket();
    this._connected = false;
  }
}
