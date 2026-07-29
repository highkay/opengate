import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { AccountEntry, AuthState } from '../types/auth.ts';
import { accounts, decrypt, loadAccountsFromFile, pickAccount, rebuildEmailIndex, reloadAccounts } from './accountManager.ts';
import { authenticateAccountsAtStartup, loadCookiesFromProfile, saveCookies } from './auth.ts';
import { getProfileDir } from './browserProfiles.ts';
import { tryRefreshToken } from './tokenRefresh.ts';

function account(email: string, password: string, state: AuthState | null = null): AccountEntry {
  return {
    email,
    password,
    state,
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

describe('authentication lifecycle persistence', () => {
  let dataDir = '';
  let previousDataDir: string | undefined;
  let previousApiKey: string | undefined;
  let previousStartupConcurrency: string | undefined;
  let previousEnvAccount: string | undefined;

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'opengate-auth-lifecycle-'));
    previousDataDir = process.env.QWEN_DATA_DIR;
    previousApiKey = process.env.API_KEY;
    previousStartupConcurrency = process.env.AUTH_STARTUP_CONCURRENCY;
    previousEnvAccount = process.env.ACCOUNT987;
    process.env.QWEN_DATA_DIR = dataDir;
    process.env.API_KEY = 'auth-lifecycle-test-key';
    delete process.env.AUTH_STARTUP_CONCURRENCY;
    delete process.env.ACCOUNT987;
    accounts.length = 0;
    rebuildEmailIndex();
  });

  afterEach(() => {
    accounts.length = 0;
    rebuildEmailIndex();
    if (previousDataDir === undefined) delete process.env.QWEN_DATA_DIR;
    else process.env.QWEN_DATA_DIR = previousDataDir;
    if (previousApiKey === undefined) delete process.env.API_KEY;
    else process.env.API_KEY = previousApiKey;
    if (previousStartupConcurrency === undefined) delete process.env.AUTH_STARTUP_CONCURRENCY;
    else process.env.AUTH_STARTUP_CONCURRENCY = previousStartupConcurrency;
    if (previousEnvAccount === undefined) delete process.env.ACCOUNT987;
    else process.env.ACCOUNT987 = previousEnvAccount;
    rmSync(dataDir, { recursive: true, force: true });
  });

  test('saveCookies atomically persists token lifecycle and encrypted password', async () => {
    const expiresAt = Date.now() + 60_000;
    const entry = account('persist@example.com', 'plain-secret', {
      token: 'old-token',
      refreshToken: 'old-refresh',
      expiresAt: Date.now() + 30_000,
    });
    accounts.push(entry);
    rebuildEmailIndex();

    await saveCookies(entry.email, 'new-token', null, expiresAt);

    const persisted = JSON.parse(readFileSync(join(dataDir, 'accounts.json'), 'utf-8'))[0];
    assert.equal(persisted.token, 'new-token');
    assert.equal(persisted.refreshToken, null);
    assert.equal(persisted.expiresAt, expiresAt);
    assert.notEqual(persisted.password, 'plain-secret');
    assert.equal(decrypt(persisted.password), 'plain-secret');
    assert.equal(entry.startupStatus, 'ready');
    assert.deepEqual(
      readdirSync(dataDir).filter((name) => name.endsWith('.tmp')),
      [],
    );
  });

  test('persists the initial API key so encrypted passwords survive API key rotation', async () => {
    const entry = account('rotation@example.com', 'rotation-secret');
    accounts.push(entry);
    rebuildEmailIndex();

    await saveCookies(entry.email, 'rotation-token', null, Date.now() + 60_000);

    const persisted = JSON.parse(readFileSync(join(dataDir, 'accounts.json'), 'utf-8'))[0];
    assert.equal(readFileSync(join(dataDir, 'master.key'), 'utf-8'), 'auth-lifecycle-test-key');

    process.env.API_KEY = 'rotated-api-key';
    assert.equal(decrypt(persisted.password), 'rotation-secret');
  });

  test('loadAccountsFromFile migrates legacy plaintext passwords', () => {
    writeFileSync(
      join(dataDir, 'accounts.json'),
      JSON.stringify([
        { email: 'legacy@example.com', password: 'legacy:secret:value', token: 'legacy-token', expiresAt: Date.now() + 60_000 },
      ]),
      'utf-8',
    );

    const loaded = loadAccountsFromFile();
    const persisted = JSON.parse(readFileSync(join(dataDir, 'accounts.json'), 'utf-8'))[0];

    assert.equal(loaded[0]?.password, 'legacy:secret:value');
    assert.notEqual(persisted.password, 'legacy:secret:value');
    assert.equal(decrypt(persisted.password), 'legacy:secret:value');
    assert.equal(persisted.token, 'legacy-token');
  });

  test('reloadAccounts merges accounts.json with env accounts instead of reading env only', async () => {
    const expiresAt = Date.now() + 60_000;
    process.env.ACCOUNT987 = 'env@example.com:env-password';
    writeFileSync(
      join(dataDir, 'accounts.json'),
      JSON.stringify([
        { email: 'file@example.com', password: 'file-password', token: 'file-token', expiresAt },
        { email: 'env@example.com', password: 'stale-file-password', token: 'env-token', expiresAt },
      ]),
      'utf-8',
    );
    accounts.push(account('obsolete-auth-lifecycle@example.com', 'obsolete'));
    rebuildEmailIndex();

    await reloadAccounts();

    const fileAccount = accounts.find((entry) => entry.email === 'file@example.com');
    const envAccount = accounts.find((entry) => entry.email === 'env@example.com');
    assert.equal(fileAccount?.state?.token, 'file-token');
    assert.equal(envAccount?.password, 'env-password');
    assert.equal(envAccount?.state?.token, 'env-token');
    assert.equal(
      accounts.some((entry) => entry.email === 'obsolete-auth-lifecycle@example.com'),
      false,
    );

    writeFileSync(join(dataDir, 'accounts.json'), JSON.stringify([{ email: 'file@example.com', password: 'file-password' }]), 'utf-8');
    await reloadAccounts();
    assert.equal(accounts.find((entry) => entry.email === 'file@example.com')?.state, null);
    assert.equal(accounts.find((entry) => entry.email === 'env@example.com')?.password, 'env-password');
  });

  test('pickAccount refuses expired tokens and selects a fresh account', async () => {
    const expired = account('expired@example.com', '', {
      token: 'expired-token',
      refreshToken: null,
      expiresAt: Date.now() - 1,
    });
    const fresh = account('fresh@example.com', '', {
      token: 'fresh-token',
      refreshToken: null,
      expiresAt: Date.now() + 10 * 60_000,
    });
    accounts.push(expired, fresh);
    rebuildEmailIndex();

    const picked = await pickAccount();

    assert.equal(picked?.email, fresh.email);
    assert.equal(expired.startupStatus, 'pending');
    assert.equal(picked?.state?.token, 'fresh-token');
  });

  test('pickAccount never refreshes an expired account before selecting a valid one', async () => {
    let expiredRefreshTouched = false;
    const expired = account('expired-with-password@example.com', 'stored-password', {
      token: 'expired-token',
      refreshToken: null,
      expiresAt: Date.now() - 1,
    });
    expired.refreshInFlight = {
      then(resolve: (value: boolean) => void) {
        expiredRefreshTouched = true;
        resolve(false);
      },
    } as Promise<boolean>;
    const fresh = account('fresh-request@example.com', '', {
      token: 'fresh-token',
      refreshToken: null,
      expiresAt: Date.now() + 10 * 60_000,
    });
    accounts.push(expired, fresh);
    rebuildEmailIndex();

    const picked = await pickAccount();

    assert.equal(picked?.email, fresh.email);
    assert.equal(expiredRefreshTouched, false);
  });

  test('startup authentication defaults to serial execution with jitter and failure backoff', async () => {
    const entries = [account('first@example.com', 'p1'), account('second@example.com', 'p2'), account('third@example.com', 'p3')];
    accounts.push(...entries);
    rebuildEmailIndex();
    const loginOrder: string[] = [];
    const delays: number[] = [];
    let active = 0;
    let maxActive = 0;

    await authenticateAccountsAtStartup(entries, {
      backoffMs: 100,
      jitterMs: 20,
      backoffMultiplier: 2,
      maxBackoffMs: 1000,
      random: () => 0.5,
      sleep: async (delayMs) => {
        delays.push(delayMs);
      },
      login: async (email) => {
        loginOrder.push(email);
        active++;
        maxActive = Math.max(maxActive, active);
        await Promise.resolve();
        active--;
        if (email !== 'third@example.com') return null;
        return { token: `${email}-token`, refreshToken: `${email}-refresh`, expiresAt: Date.now() + 60_000 };
      },
    });

    assert.equal(maxActive, 1);
    assert.deepEqual(
      loginOrder,
      entries.map((entry) => entry.email),
    );
    assert.deepEqual(delays, [110, 210]);
    assert.equal(entries[0].startupStatus, 'pending');
    assert.equal(entries[1].startupStatus, 'pending');
    assert.equal(entries[2].startupStatus, 'ready');
  });

  test('profile loading never creates an interactive browser profile implicitly', async () => {
    const email = `missing-profile-${Date.now()}@example.com`;
    const profileDir = getProfileDir(email, { create: false });
    rmSync(profileDir, { recursive: true, force: true });
    accounts.push(account(email, 'stored-password'));
    rebuildEmailIndex();

    const state = await loadCookiesFromProfile(email);

    assert.equal(state, null);
    assert.equal(existsSync(profileDir), false);
  });

  test('refresh success immediately persists new token, refresh token, and expiry', async () => {
    const entry = account('refresh@example.com', '', {
      token: 'expired-token',
      refreshToken: 'old-refresh',
      expiresAt: Date.now() - 1,
    });
    accounts.push(entry);
    rebuildEmailIndex();

    const refreshed = await tryRefreshToken(
      entry,
      async () =>
        new Response(JSON.stringify({ data: { token: 'refreshed-token', refresh_token: 'refreshed-refresh' } }), {
          status: 200,
        }),
    );

    const persisted = JSON.parse(readFileSync(join(dataDir, 'accounts.json'), 'utf-8'))[0];
    assert.equal(refreshed, true);
    assert.equal(entry.state?.token, 'refreshed-token');
    assert.equal(persisted.token, 'refreshed-token');
    assert.equal(persisted.refreshToken, 'refreshed-refresh');
    assert.equal(typeof persisted.expiresAt, 'number');
    assert.ok(persisted.expiresAt > Date.now());
  });
});
