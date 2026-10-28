import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifySignature, handleInteractions } from '../src/discord-bot.js';

async function signer() {
  const kp = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
  const pub = Buffer.from(await crypto.subtle.exportKey('raw', kp.publicKey)).toString('hex');
  const sign = async (ts, body) => Buffer.from(await crypto.subtle.sign('Ed25519', kp.privateKey, new TextEncoder().encode(ts + body))).toString('hex');
  return { pub, sign };
}

test('verifySignature: accepts a valid signature, rejects tampering and junk', async () => {
  const { pub, sign } = await signer();
  const sig = await sign('123', '{"type":1}');
  assert.equal(await verifySignature('{"type":1}', sig, '123', pub), true);
  assert.equal(await verifySignature('{"type":2}', sig, '123', pub), false);
  assert.equal(await verifySignature('{"type":1}', 'zz', '123', pub), false);
  assert.equal(await verifySignature('{"type":1}', sig, '123', ''), false);
});

test('interactions: unsigned → 401, signed PING → PONG, non-allowlisted role refused', async () => {
  const { pub, sign } = await signer();
  const env = { DISCORD_PUBLIC_KEY: pub, DISCORD_OS_ROLES: '111', DISCORD_BOT_TOKEN: 'x' };
  const mk = async (obj, good = true) => {
    const body = JSON.stringify(obj), ts = '9';
    return new Request('http://x/discord/interactions', { method: 'POST', body,
      headers: { 'x-signature-ed25519': good ? await sign(ts, body) : '00', 'x-signature-timestamp': ts } });
  };
  assert.equal((await handleInteractions(await mk({ type: 1 }, false), env)).status, 401);
  assert.deepEqual(await (await handleInteractions(await mk({ type: 1 }), env)).json(), { type: 1 });
  const r = await (await handleInteractions(await mk({ type: 3, guild_id: 'g', data: { custom_id: 'role:999' }, member: { user: { id: 'u' }, roles: [] } }), env)).json();
  assert.match(r.data.content, /not self-assignable/);
});
