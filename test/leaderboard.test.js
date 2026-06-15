// Pure helpers for the public leaderboard / profile feature.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const {
  normalizeHandle, isValidHandle, cleanDisplayName, normalizeGithubUser,
  profileFields, profileIsPublishable,
} = await import('../src/leaderboard.js');

test('normalizeHandle: canonicalizes to url-safe slug', () => {
  assert.equal(normalizeHandle('Archer Simmons'), 'archer-simmons');
  assert.equal(normalizeHandle('  --Foo__Bar!! '), 'foo-bar');
  assert.equal(normalizeHandle('a'), null);          // too short
  assert.equal(normalizeHandle('x'.repeat(33)), null); // too long
  assert.equal(normalizeHandle(''), null);
  assert.equal(normalizeHandle(null), null);
  assert.equal(normalizeHandle('---'), null);        // nothing left after trim
});

test('isValidHandle: true only for already-canonical input', () => {
  assert.equal(isValidHandle('archer-simmons'), true);
  assert.equal(isValidHandle('Archer-Simmons'), false); // uppercase → not canonical
  assert.equal(isValidHandle('-foo'), false);
  assert.equal(isValidHandle('a'), false);
  assert.equal(isValidHandle(''), false);
  assert.equal(isValidHandle(undefined), false);
});

test('cleanDisplayName: strips control chars, bounds length', () => {
  assert.equal(cleanDisplayName('Archer'), 'Archer');
  assert.equal(cleanDisplayName('Archer Simmons'), 'Archer Simmons'); // spaces/punctuation survive
  assert.equal(cleanDisplayName('foo-bar (dev)'), 'foo-bar (dev)');
  assert.equal(cleanDisplayName('a\u0000b\u001fc'), 'abc');
  assert.equal(cleanDisplayName('   '), null);
  assert.equal(cleanDisplayName('x'.repeat(50)).length, 40);
  assert.equal(cleanDisplayName(null), null);
  // Bidi overrides, zero-width, C1 controls, and BOM are stripped (board spoof).
  const RTL = String.fromCharCode(0x202e), ZWSP = String.fromCharCode(0x200b);
  const BOM = String.fromCharCode(0xfeff), C1 = String.fromCharCode(0x85);
  const CJK = String.fromCharCode(0x65e5, 0x672c); // 日本
  assert.equal(cleanDisplayName('ab' + RTL + 'cd'), 'abcd', 'RTL override stripped');
  assert.equal(cleanDisplayName('a' + ZWSP + 'b' + BOM + 'c'), 'abc', 'zero-width / BOM stripped');
  assert.equal(cleanDisplayName('x' + C1 + 'y'), 'xy', 'C1 control stripped');
  assert.equal(cleanDisplayName(CJK), CJK, 'CJK survives');
});

test('normalizeGithubUser: accepts valid, strips @ and url, rejects junk', () => {
  assert.equal(normalizeGithubUser('RARcodes'), 'RARcodes');
  assert.equal(normalizeGithubUser('@octocat'), 'octocat');
  assert.equal(normalizeGithubUser('https://github.com/torvalds'), 'torvalds');
  assert.equal(normalizeGithubUser('https://github.com/torvalds/linux'), 'torvalds');
  assert.equal(normalizeGithubUser('-bad'), null);
  assert.equal(normalizeGithubUser('a--b'), null); // consecutive hyphens invalid
  assert.equal(normalizeGithubUser(''), null);
});

test('profileFields: exposes only identity fields', () => {
  assert.deepEqual(
    profileFields({ handle: 'h', displayName: 'N', githubUser: 'g', enabled: true, secret: 'x' }),
    { handle: 'h', displayName: 'N', githubUser: 'g' },
  );
  assert.deepEqual(profileFields({}), { handle: null, displayName: null, githubUser: null });
});

test('profileIsPublishable: needs enabled + a valid handle', () => {
  assert.equal(profileIsPublishable({ enabled: true, handle: 'archer' }), true);
  assert.equal(profileIsPublishable({ enabled: false, handle: 'archer' }), false);
  assert.equal(profileIsPublishable({ enabled: true, handle: 'A' }), false);
  assert.equal(profileIsPublishable({ enabled: true }), false);
  assert.equal(profileIsPublishable({}), false);
});
