import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { AccountEntry } from '../types/auth.ts';
import { accounts, pickAccount, rebuildEmailIndex } from './accountManager.ts';

function account(email: string, overrides: Partial<AccountEntry> = {}): AccountEntry {
  return {
    email,
    password: 'secret',
    state: { token: 't', expiresAt: Date.now() + 3_600_000, refreshToken: null },
    lastUsed: 0,
    throttledUntil: 0,
    refreshInFlight: null,
    loginAttempt: 0,
    inFlight: 0,
    totalRequests: 0,
    startupStatus: 'ready',
    disabled: false,
    ...overrides,
  };
}

describe('pickAccount sticky-bind priority', () => {
  beforeEach(() => {
    accounts.length = 0;
    rebuildEmailIndex();
  });

  afterEach(() => {
    accounts.length = 0;
    rebuildEmailIndex();
  });

  test('prefers accounts whose sticky bind is healthy over flagged ones', async () => {
    const healthy = account('healthy@qwen.t', { totalRequests: 100 });
    const flagged = account('flagged@qwen.t', { proxyFailed: true, totalRequests: 0 });
    accounts.push(healthy, flagged);
    rebuildEmailIndex();

    const picked = await pickAccount();
    assert.ok(picked);
    // Least-busy-first would pick `flagged` (0 requests); the healthy bind
    // must win regardless of load counters.
    assert.strictEqual(picked!.email, 'healthy@qwen.t');
  });

  test('still serves when every bind is flagged (sort, not filter)', async () => {
    accounts.push(account('a@qwen.t', { proxyFailed: true }), account('b@qwen.t', { proxyFailed: true }));
    rebuildEmailIndex();

    const picked = await pickAccount();
    assert.ok(picked, 'flagged accounts remain candidates so they can redraw their bind on use');
  });
});
