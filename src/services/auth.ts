/*
 * File: auth.ts
 * Core authentication: login, cookies, token management.
 * Account management is in accountManager.ts. Token refresh is in tokenRefresh.ts.
 * Login is in loginService.ts. Login helpers are in loginHelpers.ts.
 */

import { existsSync } from 'fs';
import { join } from 'path';
import type { Cookie } from 'playwright';
import type { AccountEntry, AuthState } from '../types/auth.ts';
import {
  accounts,
  decodeJwt,
  discoverSavedAccounts,
  enableHotReload as enableHotReloadImpl,
  getAccountByEmail,
  type LoadedAccountData,
  loadAccountsFromFile,
  migrateFromOldPaths,
  rebuildEmailIndex,
  saveAccountsToFile,
  setupAccountWatcher as setupAccountWatcherImpl,
} from './accountManager.ts';
import { config } from './configService.ts';
import { loginFresh } from './loginService.ts';
import { logStore } from './logStore.ts';
import { getActivePage } from './playwright.ts';
import { probeAllAccounts } from './proxyManager.ts';
import { ensureAccountFresh, needsRefresh, startBackgroundTokenRefresh } from './tokenRefresh.ts';

export {
  addAccount,
  decodeJwt,
  decrementInFlight,
  discoverSavedAccounts,
  getAccountByEmail,
  getAccountCount,
  getAccountStats,
  getAccounts,
  getAllAccountEmails,
  getAvailableCount,
  getToken,
  getTokenWithAccount,
  hasInFlight,
  incrementInFlight,
  incrementTotalRequests,
  isAccountThrottled,
  isAvailable,
  pickAccount,
  rebuildEmailIndex,
  reloadAccounts,
  removeAccount,
  setAccountDisabled,
  throttleAccount,
} from './accountManager.ts';
export { ensureAccountFresh, needsRefresh, startBackgroundTokenRefresh, tryRefreshToken } from './tokenRefresh.ts';

export function getAuthTokenMaxAgeMs(): number {
  return config.getInt('AUTH_TOKEN_MAX_AGE_MS', 28800000);
}
export function getAuthRefreshBeforeMs(): number {
  return config.getInt('AUTH_REFRESH_BEFORE_MS', 300000);
}
export async function checkPlaywrightSession(): Promise<boolean> {
  try {
    const page = getActivePage();
    if (!page) return false;
    const cookies = await page.context().cookies();
    return cookies.some((c) => c.name.toLowerCase().includes('token') || c.name.toLowerCase().includes('session'));
  } catch {
    return false;
  }
}

let initDone = false;

interface StartupAuthOptions {
  concurrency?: number;
  backoffMs?: number;
  jitterMs?: number;
  backoffMultiplier?: number;
  maxBackoffMs?: number;
  login?: typeof loginFresh;
  sleep?: (delayMs: number) => Promise<void>;
  random?: () => number;
}

function getStartupLoginOptions() {
  return {
    maxAttempts: Math.max(1, Math.floor(getEnvNumber('AUTH_STARTUP_LOGIN_ATTEMPTS', 1))),
    allowBrowserRecovery: true,
    allowBrowserFallback: true,
  };
}

function getEnvNumber(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

async function runStartupTasks<T>(
  items: readonly T[],
  task: (item: T) => Promise<boolean>,
  options: StartupAuthOptions = {},
): Promise<void> {
  if (items.length === 0) return;
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? getEnvNumber('AUTH_STARTUP_CONCURRENCY', 1)));
  const backoffMs = options.backoffMs ?? getEnvNumber('AUTH_STARTUP_BACKOFF_MS', 1000);
  const jitterMs = options.jitterMs ?? getEnvNumber('AUTH_STARTUP_JITTER_MS', 500);
  const backoffMultiplier = options.backoffMultiplier ?? getEnvNumber('AUTH_STARTUP_BACKOFF_MULTIPLIER', 2);
  const maxBackoffMs = options.maxBackoffMs ?? getEnvNumber('AUTH_STARTUP_MAX_BACKOFF_MS', 15000);
  const sleep = options.sleep ?? ((delayMs: number) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const random = options.random ?? Math.random;
  let nextIndex = 0;

  const worker = async (): Promise<void> => {
    let consecutiveFailures = 0;
    let handled = 0;
    while (true) {
      const index = nextIndex++;
      if (index >= items.length) return;
      if (handled > 0) {
        const backoff = Math.min(maxBackoffMs, backoffMs * backoffMultiplier ** Math.max(0, consecutiveFailures - 1));
        await sleep(Math.max(0, Math.floor(backoff + random() * jitterMs)));
      }
      const succeeded = await task(items[index]);
      consecutiveFailures = succeeded ? 0 : consecutiveFailures + 1;
      handled++;
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
}

export async function authenticateAccountsAtStartup(
  accountsToLogin: readonly AccountEntry[],
  options: StartupAuthOptions = {},
): Promise<void> {
  const login = options.login ?? loginFresh;
  await runStartupTasks(
    accountsToLogin,
    async (acct) => {
      acct.startupStatus = 'connecting';
      try {
        const newState = await login(acct.email, acct.password);
        if (!newState) {
          acct.startupStatus = 'pending';
          return false;
        }
        await saveCookies(acct.email, newState.token, newState.refreshToken, newState.expiresAt);
        return true;
      } catch (err: any) {
        acct.startupStatus = 'pending';
        logStore.log('warn', 'auth', `Startup login failed for ${acct.email}: ${err.message}`);
        return false;
      }
    },
    options,
  );
}

export async function initAuth(onAccountReady?: (email: string) => Promise<void>): Promise<void> {
  if (initDone) return;

  migrateFromOldPaths();

  const persisted = loadAccountsFromFile();
  const discovered = discoverSavedAccounts();

  // Merge persisted accounts (including legacy token-only qwen2api entries) with env-discovered accounts.
  const merged: LoadedAccountData[] = discovered.map((a) => ({ ...a }));
  for (const p of persisted) {
    const existing = merged.find((a) => a.email.toLowerCase().trim() === p.email.toLowerCase().trim());
    if (existing) {
      if (p.password && !existing.password) {
        existing.password = p.password;
      }
      // Carry over throttledUntil from persisted data
      if (p.throttledUntil) {
        existing.throttledUntil = p.throttledUntil;
      }
      if (p.disabled !== undefined) {
        existing.disabled = p.disabled;
      }
      if (p.token) {
        existing.token = p.token;
        existing.refreshToken = p.refreshToken ?? existing.refreshToken ?? null;
        existing.expiresAt = p.expiresAt;
      }
      if (p.profileCookies && !existing.profileCookies) {
        existing.profileCookies = p.profileCookies;
      }
      // Carry over proxy binding from persisted data
      if (p.proxyUrl) {
        existing.proxyUrl = p.proxyUrl;
      }
      if (p.proxyFailed !== undefined) {
        existing.proxyFailed = p.proxyFailed;
      }
      if (p.proxyEpoch !== undefined) {
        existing.proxyEpoch = p.proxyEpoch;
      }
    } else if (p.password || p.token) {
      merged.push(p);
    }
  }

  if (merged.length === 0) {
    initDone = true;
    logStore.log(
      'warn',
      'auth',
      'No saved accounts found. Use the dashboard at http://localhost:26405/dashboard/accounts to add accounts.',
    );
    return;
  }

  accounts.length = 0;
  for (const a of merged) {
    // Reset throttledUntil to 0 if it's in the past
    const persistedUntil = (a as any).throttledUntil || 0;
    const hasPersistedToken = Boolean(a.token);
    accounts.push({
      email: a.email,
      password: a.password,
      state: hasPersistedToken
        ? {
            token: a.token!,
            expiresAt: a.expiresAt || Date.now() + getAuthTokenMaxAgeMs(),
            refreshToken: a.refreshToken ?? null,
          }
        : null,
      lastUsed: 0,
      throttledUntil: persistedUntil > Date.now() ? persistedUntil : 0,
      refreshInFlight: null,
      loginAttempt: 0,
      inFlight: 0,
      totalRequests: 0,
      profileCookies: a.profileCookies,
      disabled: (a as any).disabled ?? false,
      proxyUrl: a.proxyUrl,
      proxyFailed: a.proxyFailed,
      proxyEpoch: a.proxyEpoch,
      startupStatus: hasPersistedToken && (a.expiresAt || 0) > Date.now() ? 'ready' : 'initializing',
    });
  }
  rebuildEmailIndex();

  try {
    const startupLoginOptions = getStartupLoginOptions();
    const persistedAccounts = accounts.filter((acct) => acct.state && needsRefresh(acct));
    await runStartupTasks(persistedAccounts, async (acct) => {
      acct.startupStatus = 'connecting';
      const fresh = await ensureAccountFresh(acct, startupLoginOptions);
      acct.startupStatus = fresh ? 'ready' : 'pending';
      return fresh;
    });

    const needProfile = accounts.filter((acct) => !acct.state?.token && acct.password);
    await runStartupTasks(needProfile, async (acct) => {
      acct.startupStatus = 'connecting';
      try {
        const profileState = await loadCookiesFromProfile(acct.email);
        if (profileState) {
          acct.startupStatus = 'ready';
          return true;
        }
        acct.startupStatus = 'pending';
        return false;
      } catch (err: any) {
        acct.startupStatus = 'pending';
        logStore.log('warn', 'auth', `Profile load failed for ${acct.email}: ${err.message}`);
        return false;
      }
    });

    const needLogin = accounts.filter((a) => !a.state?.token && a.password);
    if (needLogin.length > 0) {
      const concurrency = Math.max(1, Math.floor(getEnvNumber('AUTH_STARTUP_CONCURRENCY', 1)));
      logStore.log('info', 'auth', `Logging in ${needLogin.length} accounts (max ${concurrency} concurrent)...`);
      await authenticateAccountsAtStartup(needLogin, {
        login: (email, password) => loginFresh(email, password, startupLoginOptions),
      });
    }

    // Phase 3: Run post-login callbacks in parallel
    if (onAccountReady) {
      const readyPromises = accounts
        .filter((a) => a.state?.token && a.state.expiresAt > Date.now())
        .map(async (acct) => {
          try {
            await onAccountReady(acct.email);
          } catch (err: any) {
            logStore.log('warn', 'auth', `Post-login config failed for ${acct.email}: ${err.message}`);
          }
        });
      await Promise.allSettled(readyPromises);
    }

    const successCount = accounts.filter((a) => a.state?.token && a.state.expiresAt > Date.now()).length;
    for (const acct of accounts) {
      acct.startupStatus = acct.state?.token && acct.state.expiresAt > Date.now() ? 'ready' : 'pending';
    }
    logStore.log('info', 'auth', successCount + '/' + accounts.length + ' accounts authenticated');

    startBackgroundTokenRefresh();

    setupAccountWatcherImpl();

    // Fire-and-forget proxy probe: validates every account's sticky proxy,
    // marks failures for rebind on next request. Non-blocking — the gateway
    // is already accepting traffic at this point.
    const probeEmails = accounts.filter((a) => a.state?.token).map((a) => a.email);
    if (probeEmails.length > 0 && process.env.QWEN_CHAT_PROXY) {
      probeAllAccounts(probeEmails).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        logStore.log('warn', 'proxy', `Startup proxy probe failed: ${msg}`);
      });
    }

    initDone = true;
  } catch (err) {
    initDone = false;
    throw err;
  }
}

export function setStartupStatus(email: string, status: 'initializing' | 'pending' | 'connecting' | 'ready'): void {
  const account = getAccountByEmail(email);
  if (account) account.startupStatus = status;
}

export async function loadCookiesFromProfile(email: string): Promise<AuthState | null> {
  let context: any = null;
  try {
    const { getProfileDir } = await import('./playwright.ts');
    const profileDir = getProfileDir(email, { create: false });
    const acct = accounts.find((a) => a.email.toLowerCase().trim() === email.toLowerCase().trim());

    if (!existsSync(join(profileDir, 'Default', 'Cookies'))) {
      logStore.log('debug', 'auth', `No existing browser profile for ${email}; manual login remains available from the dashboard`);
      return null;
    }

    logStore.log('info', 'auth', `Loading token from profile for ${email}...`);
    const { BROWSER_DEFAULT_ARGS } = await import('./playwright.ts');
    const { launchPersistentBrowserContext } = await import('./browserRuntime.ts');
    const PROFILE_LAUNCH_TIMEOUT_MS = 30_000;
    context = await Promise.race([
      launchPersistentBrowserContext({
        userDataDir: profileDir,
        headless: true,
        humanize: true,
        geoip: true,
        args: [...BROWSER_DEFAULT_ARGS],
      }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Profile launch timed out after 30s')), PROFILE_LAUNCH_TIMEOUT_MS),
      ),
    ]);

    try {
      const cookies = await context.cookies();
      const authCookie = cookies.find((c: Cookie) => {
        const n = c.name.toLowerCase();
        if (n.includes('refresh')) return false;
        return n.includes('token') || n.includes('session');
      });

      // Save ALL cookies as profileCookies regardless of JWT health.
      // The baxia/WAF cookies (cna, ssxmod_itna, tfstk, isg) are independent
      // of the auth token—they bypass the WAF, not authenticate.
      try {
        const cookieStr = cookies
          .filter((c: Cookie) => c.name && c.value)
          .map((c: Cookie) => `${c.name}=${c.value}`)
          .join('; ');
        if (cookieStr && acct) {
          acct.profileCookies = cookieStr;
          const { saveAccountsToFile } = await import('./accountManager.ts');
          saveAccountsToFile(accounts);
          logStore.log('info', 'auth', `Saved ${cookies.length} cookies as profile for ${email.split('@')[0]}`);
        }
      } catch (fileErr: any) {
        logStore.log('debug', 'auth', `Profile cookie save failed: ${fileErr.message}`);
      }

      if (authCookie?.value) {
        const payload = decodeJwt(authCookie.value);
        const expiresAt = payload?.exp ? payload.exp * 1000 : Date.now() + getAuthTokenMaxAgeMs();
        if (expiresAt > Date.now()) {
          const refreshCookie = cookies.find((c: Cookie) => c.name.toLowerCase().includes('refresh'));
          const state: AuthState = {
            token: authCookie.value,
            expiresAt,
            refreshToken: refreshCookie?.value || null,
          };
          await saveCookies(email, state.token, state.refreshToken, state.expiresAt);

          logStore.log('info', 'auth', `✓ Token loaded from profile for ${email}`);
          return state;
        } else {
          logStore.log('warn', 'auth', `Token expired for ${email}`);
        }
      } else {
        logStore.log('warn', 'auth', `No auth cookie found in profile for ${email}`);
      }
    } finally {
      if (context) {
        try {
          await context.close();
          context = null;
        } catch {
          /* non-blocking */
        }
      }
    }
  } catch (err: any) {
    if (err?.message?.toLowerCase().includes('lock')) {
      logStore.log('warn', 'auth', `Profile lock error for ${email}`);
    } else {
      logStore.log('warn', 'auth', `Profile cookie load failed for ${email}: ${err.message}`);
    }
    // Ensure context is cleaned up if timeout or error occurred before inner finally
    if (context) {
      try {
        await context.close();
      } catch {
        /* non-blocking */
      }
    }
  }
  return null;
}

export async function saveCookies(email: string, token: string, refreshToken?: string | null, expiresAt?: number): Promise<void> {
  const normalizedEmail = email.toLowerCase().trim();
  try {
    let jwtExpiresAt = expiresAt;
    if (!jwtExpiresAt) {
      const payload = decodeJwt(token);
      if (payload?.exp && typeof payload.exp === 'number') {
        jwtExpiresAt = payload.exp * 1000;
      } else {
        jwtExpiresAt = Date.now() + getAuthTokenMaxAgeMs();
      }
    }

    const acct = accounts.find((a) => a.email.toLowerCase().trim() === normalizedEmail);
    if (!acct) {
      throw new Error(`Account not found: ${normalizedEmail}`);
    }
    if (!token) {
      throw new Error(`Empty token for ${normalizedEmail}`);
    }
    const previousState = acct.state ? { ...acct.state } : null;
    const previousStatus = acct.startupStatus;
    const previousThrottledUntil = acct.throttledUntil;
    try {
      acct.state = {
        token,
        expiresAt: jwtExpiresAt,
        refreshToken: refreshToken !== undefined ? refreshToken : acct.state?.refreshToken || null,
      };
      acct.startupStatus = jwtExpiresAt > Date.now() ? 'ready' : 'pending';
      if (acct.throttledUntil > Date.now()) {
        acct.throttledUntil = 0;
      }
      saveAccountsToFile(accounts);
    } catch (err) {
      acct.state = previousState;
      acct.startupStatus = previousStatus;
      acct.throttledUntil = previousThrottledUntil;
      throw err;
    }
  } catch (err: any) {
    logStore.log('error', 'auth', `Failed to save cookies for ${normalizedEmail}: ${err.message}`);
    throw err;
  }
}

export function setupAccountWatcher(): void {
  setupAccountWatcherImpl();
}

export function enableHotReload(): void {
  enableHotReloadImpl();
}
