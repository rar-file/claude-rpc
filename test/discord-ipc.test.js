// The hand-rolled Discord IPC client (src/discord-ipc.js) that replaced our
// only runtime dependency. Two layers of coverage:
//   1. Pure wire functions — frame encode/decode + activity→payload mapping.
//      These must be byte-identical to what @xhayper produced or the rendered
//      card changes.
//   2. A full client round-trip against a fake Discord server over a real unix
//      socket: handshake → READY → setActivity → clearActivity → ping/pong →
//      disconnect, exercising the exact API surface src/daemon.js calls.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

const {
  encodeFrame,
  createFrameDecoder,
  formatActivity,
  candidatePaths,
  Client,
  OP_HANDSHAKE,
  OP_FRAME,
  OP_PING,
  OP_PONG,
  ARRPC_USER_ID,
  isBridgeUser,
} = await import('../src/discord-ipc.js');

// ── Frame encode / decode ────────────────────────────────────────────────
test('encodeFrame writes an 8-byte LE header + JSON body', () => {
  const buf = encodeFrame(OP_FRAME, { hi: 1 });
  assert.equal(buf.readUInt32LE(0), OP_FRAME);
  const body = JSON.stringify({ hi: 1 });
  assert.equal(buf.readUInt32LE(4), Buffer.byteLength(body));
  assert.equal(buf.subarray(8).toString(), body);
});

test('encodeFrame with no data emits a zero-length body (PONG/clear case)', () => {
  const buf = encodeFrame(OP_HANDSHAKE, undefined);
  assert.equal(buf.length, 8);
  assert.equal(buf.readUInt32LE(4), 0);
});

test('decoder reassembles a frame split across chunks', () => {
  const push = createFrameDecoder();
  const full = encodeFrame(OP_FRAME, { cmd: 'X', nonce: 'n' });
  assert.deepEqual(push(full.subarray(0, 3)), []); // header not complete yet
  assert.deepEqual(push(full.subarray(3, 10)), []); // body not complete yet
  const out = push(full.subarray(10));
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], { op: OP_FRAME, data: { cmd: 'X', nonce: 'n' } });
});

test('decoder splits multiple frames coalesced in one chunk', () => {
  const push = createFrameDecoder();
  const a = encodeFrame(OP_FRAME, { a: 1 });
  const b = encodeFrame(OP_PING, { b: 2 });
  const out = push(Buffer.concat([a, b]));
  assert.equal(out.length, 2);
  assert.equal(out[0].data.a, 1);
  assert.equal(out[1].op, OP_PING);
});

test('decoder skips a malformed frame without losing the buffer', () => {
  const push = createFrameDecoder();
  // Hand-craft a frame whose body is not valid JSON.
  const bad = Buffer.from('not json');
  const header = Buffer.alloc(8);
  header.writeUInt32LE(OP_FRAME, 0);
  header.writeUInt32LE(bad.length, 4);
  const good = encodeFrame(OP_FRAME, { ok: true });
  const out = push(Buffer.concat([header, bad, good]));
  assert.equal(out.length, 1);
  assert.equal(out[0].data.ok, true);
});

// ── Activity mapping (fidelity vs @xhayper) ──────────────────────────────
test('formatActivity maps the friendly object to Discord payload shape', () => {
  const { pid, activity } = formatActivity(
    {
      name: 'Claude Code',
      details: 'Editing daemon.js',
      state: 'in claude-rpc',
      startTimestamp: 1700000000000,
      largeImageKey: 'opus',
      largeImageText: 'Opus 4.8',
      smallImageKey: 'working',
      smallImageText: 'Working',
      buttons: [{ label: 'View on GitHub →', url: 'https://example.com' }],
    },
    4242,
  );
  assert.equal(pid, 4242);
  assert.equal(activity.name, 'Claude Code');
  assert.equal(activity.type, 0); // Playing default
  assert.equal(activity.instance, false);
  assert.equal(activity.details, 'Editing daemon.js');
  assert.equal(activity.state, 'in claude-rpc');
  assert.deepEqual(activity.timestamps, { start: 1700000000000 });
  assert.deepEqual(activity.assets, {
    large_image: 'opus',
    large_text: 'Opus 4.8',
    small_image: 'working',
    small_text: 'Working',
  });
  assert.deepEqual(activity.buttons, [{ label: 'View on GitHub →', url: 'https://example.com' }]);
});

test('formatActivity omits empty groups and honors type override', () => {
  const { activity } = formatActivity({ details: 'x', type: 3 });
  assert.equal(activity.type, 3);
  assert.equal('timestamps' in activity, false);
  assert.equal('assets' in activity, false);
  assert.equal('buttons' in activity, false);
});

test('formatActivity accepts a Date startTimestamp', () => {
  const d = new Date(1700000000000);
  const { activity } = formatActivity({ details: 'x', startTimestamp: d });
  assert.equal(activity.timestamps.start, 1700000000000);
});

test('formatActivity defaults pid to the current process', () => {
  const { pid } = formatActivity({ details: 'x' });
  assert.equal(pid, process.pid);
});

// ── candidatePaths ───────────────────────────────────────────────────────
test('candidatePaths returns the 10 named pipes on win32', () => {
  const paths = candidatePaths('win32');
  assert.equal(paths.length, 10);
  assert.equal(paths[0], '\\\\?\\pipe\\discord-ipc-0');
  assert.equal(paths[9], '\\\\?\\pipe\\discord-ipc-9');
});

// ── Full client round-trip against a fake Discord ────────────────────────
// A minimal server that speaks the Discord IPC protocol well enough to drive
// the client through its whole lifecycle. Returns the socket path + a handle
// to inspect what the client sent and to push frames back.
// performance.now() floored to whole ms isn't unique enough on its own — two
// servers started in the same test within the same millisecond collide on
// path, and the second `listen()` unlinks + steals the first's socket file
// out from under it. A per-call counter guarantees distinct paths regardless
// of timing.
// net.Server.listen() takes a filesystem path on posix but requires a named
// pipe there on Windows (confirmed live in CI: a plain tmpdir path throws
// EACCES) — same reason production candidatePaths() branches for win32.
let fakeDiscordSeq = 0;
function startFakeDiscord(t, { onHandshake, onFrame } = {}) {
  const id = `fake-ipc-${process.pid}-${Math.floor(performance.now())}-${fakeDiscordSeq++}`;
  const sockPath = process.platform === 'win32' ? `\\\\.\\pipe\\${id}` : path.join(os.tmpdir(), id);
  if (process.platform !== 'win32') {
    try {
      fs.unlinkSync(sockPath);
    } catch {
      /* fresh path */
    }
  }
  const received = [];
  let conn = null;
  const server = net.createServer((socket) => {
    conn = socket;
    const decode = createFrameDecoder();
    socket.on('data', (chunk) => {
      for (const frame of decode(chunk)) {
        received.push(frame);
        if (frame.op === OP_HANDSHAKE && onHandshake) onHandshake(socket, frame);
        else if (frame.op === OP_FRAME && onFrame) onFrame(socket, frame);
      }
    });
  });
  t.after(() => {
    try {
      server.close();
    } catch {
      /* already closed */
    }
  });
  return new Promise((resolve) => {
    server.listen(sockPath, () => resolve({ sockPath, received, server, getConn: () => conn }));
  });
}

const sendReady = (socket, user) =>
  socket.write(encodeFrame(OP_FRAME, { cmd: 'DISPATCH', evt: 'READY', data: { user } }));
const sendResponse = (socket, frame) =>
  socket.write(encodeFrame(OP_FRAME, { cmd: frame.data.cmd, data: {}, evt: null, nonce: frame.data.nonce }));

test('login handshakes, receives READY, and exposes the user', async (t) => {
  const fake = await startFakeDiscord(t, {
    onHandshake: (socket) => sendReady(socket, { username: 'archer', id: '42' }),
  });
  const client = new Client({ clientId: 'cid-123', transport: { pathList: [fake.sockPath] } });
  t.after(() => client.destroy());

  let readyFired = false;
  client.on('ready', () => (readyFired = true));
  await client.login();

  assert.equal(readyFired, true);
  assert.equal(client.user.username, 'archer');
  // The handshake the client sent must carry v:1 + our clientId.
  const hs = fake.received.find((f) => f.op === OP_HANDSHAKE);
  assert.deepEqual(hs.data, { v: 1, client_id: 'cid-123' });
});

test('setActivity sends a nonce-matched SET_ACTIVITY and resolves on reply', async (t) => {
  const fake = await startFakeDiscord(t, {
    onHandshake: (socket) => sendReady(socket, { username: 'u' }),
    onFrame: (socket, frame) => sendResponse(socket, frame), // ack every request
  });
  const client = new Client({ clientId: 'c', transport: { pathList: [fake.sockPath] } });
  t.after(() => client.destroy());
  await client.login();

  await client.user.setActivity({ details: 'Editing', state: 'claude-rpc', largeImageKey: 'opus' });

  const setFrame = fake.received.find((f) => f.op === OP_FRAME && f.data.cmd === 'SET_ACTIVITY');
  assert.ok(setFrame, 'server should have received a SET_ACTIVITY frame');
  assert.ok(setFrame.data.nonce, 'request must carry a nonce');
  assert.equal(setFrame.data.args.activity.details, 'Editing');
  assert.equal(setFrame.data.args.activity.assets.large_image, 'opus');
  assert.equal(setFrame.data.args.pid, process.pid);
});

test('clearActivity sends SET_ACTIVITY with no activity', async (t) => {
  const fake = await startFakeDiscord(t, {
    onHandshake: (socket) => sendReady(socket, { username: 'u' }),
    onFrame: (socket, frame) => sendResponse(socket, frame),
  });
  const client = new Client({ clientId: 'c', transport: { pathList: [fake.sockPath] } });
  t.after(() => client.destroy());
  await client.login();

  await client.user.clearActivity();
  const frames = fake.received.filter((f) => f.op === OP_FRAME && f.data.cmd === 'SET_ACTIVITY');
  const clear = frames[frames.length - 1];
  assert.equal('activity' in clear.data.args, false);
  assert.equal(clear.data.args.pid, process.pid);
});

test('a server PING is answered with a PONG echoing the payload', async (t) => {
  const fake = await startFakeDiscord(t, {
    onHandshake: (socket) => {
      sendReady(socket, { username: 'u' });
      socket.write(encodeFrame(OP_PING, { token: 'ping-1' }));
    },
  });
  const client = new Client({ clientId: 'c', transport: { pathList: [fake.sockPath] } });
  t.after(() => client.destroy());
  await client.login();

  // Give the ping a tick to round-trip.
  await new Promise((r) => setTimeout(r, 50));
  const pong = fake.received.find((f) => f.op === OP_PONG);
  assert.ok(pong, 'client should answer PING with PONG');
  assert.deepEqual(pong.data, { token: 'ping-1' });
});

test('login connects concurrently across candidates, preferring the earliest path when several accept', async (t) => {
  // Windows probes all 10 named-pipe candidates with no existence pre-check,
  // so _openSocket races them instead of trying one at a time (worst case:
  // up to 10× the per-candidate timeout). With two live fakes, the earlier
  // path must still win — and the loser's socket must be destroyed, not leaked.
  const first = await startFakeDiscord(t, { onHandshake: (s) => sendReady(s, { username: 'first' }) });
  const second = await startFakeDiscord(t, { onHandshake: (s) => sendReady(s, { username: 'second' }) });
  const client = new Client({ clientId: 'c', transport: { pathList: [first.sockPath, second.sockPath] } });
  t.after(() => client.destroy());
  await client.login();
  assert.equal(client.user.username, 'first', 'earlier candidate wins even though both accept');
  // The client-side destroy() sends a FIN the server observes asynchronously —
  // give it a tick to propagate before checking the server saw its end close.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(second.getConn().destroyed, true, 'the losing candidate is closed, not left open');
});

test('login rejects when no Discord socket can be reached', async (t) => {
  const client = new Client({
    clientId: 'c',
    transport: { pathList: [path.join(os.tmpdir(), 'definitely-not-a-socket-xyz')] },
  });
  t.after(() => client.destroy());
  await assert.rejects(() => client.login(), /Could not connect/);
});

test('server close after ready emits disconnected', async (t) => {
  const fake = await startFakeDiscord(t, {
    onHandshake: (socket) => sendReady(socket, { username: 'u' }),
  });
  const client = new Client({ clientId: 'c', transport: { pathList: [fake.sockPath] } });
  t.after(() => client.destroy());
  await client.login();

  const disconnected = new Promise((resolve) => client.once('disconnected', resolve));
  fake.getConn().destroy();
  await disconnected; // resolves only if 'disconnected' fired
});

test('in-flight setActivity rejects if the connection drops', async (t) => {
  const fake = await startFakeDiscord(t, {
    onHandshake: (socket) => sendReady(socket, { username: 'u' }),
    onFrame: (socket) => socket.destroy(), // never reply; kill the socket
  });
  const client = new Client({ clientId: 'c', transport: { pathList: [fake.sockPath] } });
  t.after(() => client.destroy());
  await client.login();
  await assert.rejects(() => client.user.setActivity({ details: 'x' }));
});

// ── Party size (concurrent sessions) ─────────────────────────────────────
test('formatActivity maps party fields to Discord party shape', () => {
  const { activity } = formatActivity({
    details: 'x',
    partyId: 'claude-rpc',
    partySize: 2,
    partyMax: 3,
  });
  assert.deepEqual(activity.party, { id: 'claude-rpc', size: [2, 3] });
});

test('formatActivity omits party when size is one-ended or absent', () => {
  assert.equal('party' in formatActivity({ details: 'x' }).activity, false);
  // size needs both ends; a lone partySize is dropped (no id either → no party)
  assert.equal('party' in formatActivity({ details: 'x', partySize: 2 }).activity, false);
});

// ── Bridge detection (arRPC / Vesktop / Equibop) ─────────────────────────
test('isBridgeUser: recognizes arRPC\'s mock READY user by id or username', () => {
  // The exact shape arRPC's server sends in its READY dispatch.
  assert.equal(isBridgeUser({ id: ARRPC_USER_ID, username: 'arrpc', discriminator: '0' }), true);
  assert.equal(isBridgeUser({ id: 'something-else', username: 'arrpc' }), true, 'username alone suffices');
  assert.equal(isBridgeUser({ id: ARRPC_USER_ID, username: 'renamed' }), true, 'id alone suffices');
  assert.equal(isBridgeUser({ id: ARRPC_USER_ID }), true);
});

test('isBridgeUser: real accounts are not bridges', () => {
  assert.equal(isBridgeUser({ id: '80351110224678912', username: 'rafii' }), false);
  assert.equal(isBridgeUser({ id: '1', username: 'arrpc-fan' }), false, 'exact username match only');
  assert.equal(isBridgeUser(null), false);
  assert.equal(isBridgeUser({}), false);
});
