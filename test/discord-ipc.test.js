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
function startFakeDiscord(t, { onHandshake, onFrame } = {}) {
  const sockPath = path.join(os.tmpdir(), `fake-ipc-${process.pid}-${Math.floor(performance.now())}`);
  try {
    fs.unlinkSync(sockPath);
  } catch {
    /* fresh path */
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
