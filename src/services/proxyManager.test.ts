import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { AccountEntry } from '../types/auth.ts';
import { accounts, rebuildEmailIndex } from './accountManager.ts';
import { buildAccountProxy, getAccountProxy, markProxyFailed, proxyEpochOf, sanitizeEmail } from './proxyManager.ts';

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

describe('proxyManager', () => {
  let previousChatProxy: string | undefined;
  let previousProxy: string | undefined;
  let previousLoginProxy: string | undefined;

  beforeEach(() => {
    previousChatProxy = process.env.QWEN_CHAT_PROXY;
    previousProxy = process.env.QWEN_PROXY;
    previousLoginProxy = process.env.QWEN_LOGIN_PROXY;
    process.env.QWEN_CHAT_PROXY = 'http://Default:highkay1844@192.168.1.18:2260';
    accounts.length = 0;
    rebuildEmailIndex();
  });

  afterEach(() => {
    accounts.length = 0;
    rebuildEmailIndex();
    if (previousChatProxy === undefined) delete process.env.QWEN_CHAT_PROXY;
    else process.env.QWEN_CHAT_PROXY = previousChatProxy;
    if (previousProxy === undefined) delete process.env.QWEN_PROXY;
    else process.env.QWEN_PROXY = previousProxy;
    if (previousLoginProxy === undefined) delete process.env.QWEN_LOGIN_PROXY;
    else process.env.QWEN_LOGIN_PROXY = previousLoginProxy;
  });

  test('sanitizeEmail strips domain and non-safe chars', () => {
    assert.equal(sanitizeEmail('tmppowpwl7673@highkay.qzz.io'), 'tmppowpwl7673');
    assert.equal(sanitizeEmail('a+b.c_d@example.com'), 'a_b_c_d');
  });

  test('buildAccountProxy embeds sanitized email into the template', () => {
    const proxy = buildAccountProxy('tmpacct1@highkay.qzz.io');
    assert.equal(proxy, 'http://Default.tmpacct1:highkay1844@192.168.1.18:2260');
  });

  test('buildAccountProxy appends epoch suffix when epoch > 0', () => {
    const proxy = buildAccountProxy('tmpacct1@highkay.qzz.io', 3);
    assert.equal(proxy, 'http://Default.tmpacct1-e3:highkay1844@192.168.1.18:2260');
    assert.equal(proxyEpochOf(proxy), 3);
  });

  test('proxyEpochOf parses epoch suffix', () => {
    assert.equal(proxyEpochOf('http://Default.tmpacct1-e7:pass@h:1'), 7);
    assert.equal(proxyEpochOf('http://Default.tmpacct1:pass@h:1'), 0);
  });

  test('buildAccountProxy returns null when no proxy env is configured', () => {
    delete process.env.QWEN_CHAT_PROXY;
    delete process.env.QWEN_PROXY;
    delete process.env.QWEN_LOGIN_PROXY;
    assert.equal(buildAccountProxy('a@b.c'), null);
  });

  test('getAccountProxy binds a sticky proxy to the account and reuses it', () => {
    const acct = account('tmpacct1@highkay.qzz.io');
    accounts.push(acct);
    rebuildEmailIndex();

    const first = getAccountProxy(acct.email);
    const second = getAccountProxy(acct.email);

    assert.equal(first, 'http://Default.tmpacct1:highkay1844@192.168.1.18:2260');
    assert.equal(second, first);
    assert.equal(acct.proxyUrl, first);
    assert.equal(acct.proxyFailed, false);
  });

  test('markProxyFailed rebinds to a DIFFERENT session suffix (new IP)', () => {
    const acct = account('tmpacct1@highkay.qzz.io');
    accounts.push(acct);
    rebuildEmailIndex();

    const first = getAccountProxy(acct.email);
    assert.equal(first, 'http://Default.tmpacct1:highkay1844@192.168.1.18:2260');
    assert.equal(acct.proxyEpoch, 0);

    markProxyFailed(acct.email);
    assert.equal(acct.proxyFailed, true);
    assert.equal(acct.proxyEpoch, 1);

    // Rebind must yield a DIFFERENT session suffix → different exit IP
    const second = getAccountProxy(acct.email);
    assert.equal(second, 'http://Default.tmpacct1-e1:highkay1844@192.168.1.18:2260');
    assert.notEqual(second, first);
    assert.equal(acct.proxyFailed, false);
    assert.equal(acct.proxyEpoch, 1);
  });

  test('multiple failures keep bumping the epoch', () => {
    const acct = account('tmpacct1@highkay.qzz.io');
    accounts.push(acct);
    rebuildEmailIndex();

    getAccountProxy(acct.email); // epoch 0
    markProxyFailed(acct.email); // epoch 1
    getAccountProxy(acct.email); // -e1
    markProxyFailed(acct.email); // epoch 2
    const third = getAccountProxy(acct.email);

    assert.equal(third, 'http://Default.tmpacct1-e2:highkay1844@192.168.1.18:2260');
    assert.equal(acct.proxyEpoch, 2);
  });

  test('getAccountProxy falls back to default when no account is registered', () => {
    const proxy = getAccountProxy('ghost@example.com');
    assert.equal(proxy, 'http://Default.ghost:highkay1844@192.168.1.18:2260');
  });
});
