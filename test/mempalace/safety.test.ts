import assert from 'node:assert/strict';
import test from 'node:test';

import {
  WRITE_CONTENT_MAX_CHARS,
  WRITE_METADATA_MAX_CHARS,
  WriteSafetyError,
  createWriteSafetyGate,
} from '../../integration/safety.ts';

test('shared safety gate accepts an ordinary bounded candidate', () => {
  assert.doesNotThrow(() => createWriteSafetyGate()({ content: 'ordinary project finding' }));
});

test('shared safety gate rejects every credential class without redaction', () => {
  const gate = createWriteSafetyGate();
  for (const content of [
    'password=hunter2',
    'api_key=sk-test-secret',
    'access_token=secret',
    'Authorization: Bearer secret',
    'session_id=secret',
    'token=supersecret',
    'Bearer supersecret',
    'Cookie: session=supersecret',
    'postgres://alice:supersecret@db.example/prod',
    '-----BEGIN PRIVATE KEY-----\nsecret',
    'xoxb-1234567890123456789012345678',
    'xoxp-1234567890123456789012345678',
    'xoxr-1234567890123456789012345678',
    'xoxs-1234567890123456789012345678',
    'xoxa-1234567890123456789012345678',
    'sk_live_12345678901234567890123456',
    'sk_test_12345678901234567890123456',
    'glpat-abcdefghij1234567890abcde',
    'hf_12345678901234567890abcdefgh',
    'AIza1234567890abcdefghijklmnopqrstuvwxyzabcdefghijk',
    'GOCSPX-1234567890abcdefghijklmnop',
    'npm_123456789012345678901234567890123456',
    'ASIA1234567890ABCDEF',
  ]) {
    assert.throws(() => gate({ content }), (error) => {
      assert.ok(error instanceof WriteSafetyError);
      assert.equal(error.reason, 'credential');
      return true;
    });
  }
});

test('shared safety gate rejects retain:false and a first-line no-memory marker', () => {
  const gate = createWriteSafetyGate();
  assert.throws(() => gate({ content: 'ordinary', retain: false }), /non-retainable/i);
  assert.throws(() => gate({ content: '[no-memory]\nordinary' }), /non-retainable/i);
  assert.throws(() => gate({ content: ' [NO-MEMORY] do not store' }), /non-retainable/i);
  assert.doesNotThrow(() => gate({ content: 'ordinary\n[no-memory]' }));
});

test('shared safety gate rejects the whole empty or over-limit candidate', () => {
  const gate = createWriteSafetyGate();
  assert.throws(() => gate({ content: '' }), /empty/i);
  assert.throws(
    () => gate({ content: 'x'.repeat(WRITE_CONTENT_MAX_CHARS + 1) }),
    new RegExp(String(WRITE_CONTENT_MAX_CHARS)),
  );
});

test('shared safety gate inspects and bounds every persisted metadata field', () => {
  const gate = createWriteSafetyGate();
  for (const metadata of [
    'token=supersecret',
    'Cookie: session=supersecret',
    'postgres://alice:supersecret@db.example/prod',
  ]) {
    assert.throws(() => gate({ content: 'ordinary', metadata: [metadata] }), /credential/i);
  }
  assert.throws(
    () => gate({ content: 'ordinary', metadata: ['x'.repeat(WRITE_METADATA_MAX_CHARS + 1)] }),
    /metadata.*limit/i,
  );
  assert.throws(
    () => gate({ content: 'ordinary', metadata: ['[no-memory] do not retain'] }),
    /non-retainable/i,
  );
});

test('read-only safety gate rejects before dispatch', () => {
  assert.throws(
    () => createWriteSafetyGate({ readOnly: true })({ content: 'ordinary' }),
    /read-only/i,
  );
});
