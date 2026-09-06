import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { AccountEntry } from '../types/auth.ts';
import { accounts, rebuildEmailIndex } from './accountManager.ts';
import { browserlessFetch } from './browserlessFetch.ts';
import { getAccountProxy, proxyEpochOf } from './proxyManager.ts';

function account(email: string): AccountEntry {
  return {
    email,
    password: 'secret',
    state: null,
    lastUsed: 0,
    throttledUntil: 0,
    refreshInFlight: null,
    loginAttempt: 0,
    inFlight: 0,
    totalRequests: 0,
    startupStatus: 'pending',
    disabled: false,
  };
}

describe('browserlessFetch dead sticky bind', () => {
  let previousChatProxy: string | undefined;
  let previousMockPlaywright: string | undefined;
  const email = 'dead-bind-acct@qwen.t';

  beforeEach(() => {
    // tests/index.test.ts sets TEST_MOCK_PLAYWRIGHT at module load and never
    // restores it — the mock branch of browserlessFetch skips the proxy
    // machinery entirely, so clear it for this test and restore afterwards.
    previousMockPlaywright = process.env.TEST_MOCK_PLAYWRIGHT;
    delete process.env.TEST_MOCK_PLAYWRIGHT;
    previousChatProxy = process.env.QWEN_CHAT_PROXY;
    process.env.QWEN_CHAT_PROXY = 'http://Default:highkay1844@192.168.1.18:2260';
    accounts.length = 0;
    accounts.push(account(email));
    rebuildEmailIndex();
  });

  afterEach(() => {
    accounts.length = 0;
    rebuildEmailIndex();
    if (previousChatProxy === undefined) delete process.env.QWEN_CHAT_PROXY;
    else process.env.QWEN_CHAT_PROXY = previousChatProxy;
    if (previousMockPlaywright === undefined) delete process.env.TEST_MOCK_PLAYWRIGHT;
    else process.env.TEST_MOCK_PLAYWRIGHT = previousMockPlaywright;
  });

  test('transport failure during bx-umidtoken extraction marks the proxy failed so the account rebinds', async () => {
    // Dead sticky bind (nothing listens on port 1 → instant refusal). Before
    // the guarded-region fix, extractBxUmidtoken threw out of browserlessFetch
    // above the try block, so markProxyFailed never ran and the account kept
    // its dead sticky URL forever (same resin username → same dead node).
    await assert.rejects(
      browserlessFetch('https://chat.qwen.ai/api/v2/chats/new', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        accountEmail: email,
        proxy: 'http://127.0.0.1:1',
        signal: AbortSignal.timeout(5_000),
      }),
    );

    const acct = accounts[0];
    assert.strictEqual(acct.proxyFailed, true);
    assert.strictEqual(acct.proxyEpoch, 1);

    const rebound = getAccountProxy(email);
    assert.ok(rebound);
    assert.strictEqual(proxyEpochOf(rebound!), 1);
    assert.match(rebound!, /-e1:highkay1844@192\.168\.1\.18:2260$/);
  });
});