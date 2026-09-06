import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { AccountEntry } from '../types/auth.ts';
import { accounts, pickAccount, rebuildEmailIndex, reloadAccounts } from './accountManager.ts';

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

describe('reloadAccounts preserves live proxy health', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'accounts-reload-test-'));
    process.env.QWEN_DATA_DIR = dir;
    accounts.length = 0;
    rebuildEmailIndex();
  });

  afterEach(() => {
    accounts.length = 0;
    rebuildEmailIndex();
    delete process.env.QWEN_DATA_DIR;
    rmSync(dir, { recursive: true, force: true });
  });

  test('does not clobber in-memory proxyFailed/proxyEpoch with persisted values', async () => {
    // Persisted file claims the bind failed (lagging write from an earlier
    // process); live memory has since rebound and re-validated it.
    writeFileSync(
      join(dir, 'accounts.json'),
      JSON.stringify([
        {
          email: 'live@qwen.t',
          password: 'encrypted',
          token: 'persisted-token',
          expiresAt: Date.now() + 3_600_000,
          proxyUrl: 'http://Default.live-e9:pass@h:1',
          proxyFailed: true,
          proxyEpoch: 9,
        },
      ]),
    );
    accounts.push(account('live@qwen.t', { proxyUrl: 'http://Default.live-e2:pass@h:1', proxyFailed: false, proxyEpoch: 2 }));
    rebuildEmailIndex();

    await reloadAccounts();

    const live = accounts.find((a) => a.email === 'live@qwen.t');
    assert.ok(live);
    assert.strictEqual(live!.proxyFailed, false);
    assert.strictEqual(live!.proxyEpoch, 2);
    assert.strictEqual(live!.proxyUrl, 'http://Default.live-e2:pass@h:1');
  });
});
