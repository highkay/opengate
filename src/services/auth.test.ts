import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { accounts } from './accountManager.ts';
import {
  decrementInFlight,
  getAccountByEmail,
  hasInFlight,
  incrementInFlight,
  incrementTotalRequests,
  rebuildEmailIndex,
  saveCookies,
} from './auth.ts';

describe('account inFlight and totalRequests tracking', () => {
  test('incrementInFlight increments and decrementInFlight decrements', () => {
    // These should not throw even if account doesn't exist
    incrementInFlight('nonexistent@test');
    decrementInFlight('nonexistent@test');
  });

  test('incrementTotalRequests increments counter', () => {
    incrementTotalRequests('nonexistent@test'); // should not throw
  });

  test('hasInFlight returns false for nonexistent account', () => {
    assert.strictEqual(hasInFlight('nobody@test'), false);
  });
});

describe('saveCookies and account state', () => {
  const testEmail = 'savecookies-test@example.com';
  let dataDir = '';
  let previousDataDir: string | undefined;

  beforeEach(() => {
    previousDataDir = process.env.QWEN_DATA_DIR;
    dataDir = mkdtempSync(join(tmpdir(), 'opengate-auth-test-'));
    process.env.QWEN_DATA_DIR = dataDir;
    accounts.push({
      email: testEmail,
      password: 'test-pass',
      state: null,
      lastUsed: 0,
      throttledUntil: 0,
      refreshInFlight: null,
      loginAttempt: 0,
      inFlight: 0,
      totalRequests: 0,
    });
    rebuildEmailIndex();
  });

  afterEach(() => {
    accounts.length = 0;
    rebuildEmailIndex();
    if (previousDataDir === undefined) delete process.env.QWEN_DATA_DIR;
    else process.env.QWEN_DATA_DIR = previousDataDir;
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('saveCookies updates account state', async () => {
    assert.equal(accounts.find((a) => a.email === testEmail)?.state, null);
    await saveCookies(testEmail, 'test-token-value', 'test-refresh', Date.now() + 3600000);
    const acct = accounts.find((a) => a.email === testEmail);
    assert.notEqual(acct?.state, null);
    assert.equal(acct?.state?.token, 'test-token-value');
    assert.equal(acct?.state?.refreshToken, 'test-refresh');
  });
});

describe('getAccountByEmail', () => {
  beforeEach(() => {
    accounts.push(
      {
        email: 'MixedCase@Example.com',
        password: 'p1',
        state: null,
        lastUsed: 0,
        throttledUntil: 0,
        refreshInFlight: null,
        loginAttempt: 0,
        inFlight: 0,
        totalRequests: 0,
      },
      {
        email: 'lowercase@example.com',
        password: 'p2',
        state: null,
        lastUsed: 0,
        throttledUntil: 0,
        refreshInFlight: null,
        loginAttempt: 0,
        inFlight: 0,
        totalRequests: 0,
      },
    );
    rebuildEmailIndex();
  });

  afterEach(() => {
    accounts.length = 0;
    rebuildEmailIndex();
  });

  test('finds account regardless of case', () => {
    const found = getAccountByEmail('mixedcase@example.com');
    assert.notEqual(found, null);
    assert.equal(found?.email, 'MixedCase@Example.com');

    const found2 = getAccountByEmail('MIXEDCASE@EXAMPLE.COM');
    assert.notEqual(found2, null);
    assert.equal(found2?.email, 'MixedCase@Example.com');
  });

  test('returns null for unknown email', () => {
    assert.equal(getAccountByEmail('unknown@test.com'), null);
  });
});

// throttleAccount test intentionally removed — it called saveAccountsToFile
// which wrote test data to the real .qwen/accounts.json
