/*
 * File: tokenRefresh.ts
 * Token refresh logic extracted from auth.ts.
 * Handles refresh token exchange and ensuring accounts stay fresh.
 */

import type { AccountEntry } from '../types/auth.ts';
import { getAccounts, getAuthRefreshBeforeMs, saveCookies } from './auth.ts';
import { browserlessFetch } from './browserlessFetch.ts';
import { type LoginOptions, loginFresh } from './loginService.ts';
import { logStore } from './logStore.ts';

export function needsRefresh(acct: AccountEntry): boolean {
  if (!acct.state) return true;
  return acct.state.expiresAt - getAuthRefreshBeforeMs() < Date.now();
}

const QWEN_CHAT_URL = 'https://chat.qwen.ai';

export async function tryRefreshToken(acct: AccountEntry, fetcher: typeof browserlessFetch = browserlessFetch): Promise<boolean> {
  if (!acct.state?.refreshToken) return false;

  try {
    const resp = await fetcher(`${QWEN_CHAT_URL}/api/v2/auths/refresh`, {
      method: 'POST',
      body: JSON.stringify({ refresh_token: acct.state.refreshToken }),
      // Refresh is part of the login path — route through the login-dedicated
      // dynamic proxy when configured so it also bypasses the IP-level WAF.
      proxy: process.env.QWEN_LOGIN_PROXY || process.env.QWEN_PROXY || undefined,
    });

    if (!resp.ok) return false;

    const body = await resp.text();
    const data = JSON.parse(body);
    if (!data.data?.token) return false;

    await saveCookies(acct.email, data.data.token, data.data.refresh_token ?? acct.state.refreshToken);
    return true;
  } catch (err: any) {
    logStore.log('error', 'auth', 'HTTP fetch failed:', err);
    return false;
  }
}

export async function ensureAccountFresh(acct: AccountEntry, loginOptions: LoginOptions = {}): Promise<boolean> {
  if (acct.state && !needsRefresh(acct)) {
    acct.startupStatus = 'ready';
    return true;
  }

  // Avoid concurrent refresh for same account
  if (acct.refreshInFlight) {
    return acct.refreshInFlight;
  }

  acct.refreshInFlight = (async () => {
    try {
      acct.startupStatus = 'connecting';
      if (acct.state?.refreshToken) {
        if (await tryRefreshToken(acct)) return true;
        logStore.log('warn', 'auth', `Refresh token failed for ${acct.email}`);
      }

      if (acct.throttledUntil > Date.now()) {
        const waitSec = Math.ceil((acct.throttledUntil - Date.now()) / 1000);
        logStore.log('warn', 'auth', `Skipping re-login for ${acct.email} — throttled for ${waitSec}s more`);
        acct.startupStatus = 'pending';
        return false;
      }

      if (!acct.password) {
        acct.startupStatus = 'pending';
        return false;
      }

      const newState = await loginFresh(acct.email, acct.password, loginOptions);
      if (newState) {
        await saveCookies(acct.email, newState.token, newState.refreshToken, newState.expiresAt);
        return true;
      }
      acct.startupStatus = 'pending';
      return false;
    } catch (err: any) {
      acct.startupStatus = 'pending';
      logStore.log('error', 'auth', `Failed to refresh ${acct.email}: ${err.message}`);
      return false;
    } finally {
      acct.refreshInFlight = null;
    }
  })();

  return acct.refreshInFlight;
}

const BACKGROUND_REFRESH_INTERVAL_MS = 2 * 60 * 1000;
let backgroundRefreshStarted = false;

export function startBackgroundTokenRefresh(): void {
  if (backgroundRefreshStarted) return;
  backgroundRefreshStarted = true;
  logStore.log('info', 'auth', 'Background token refresh started (every 2min)');

  const tick = async () => {
    const allAccounts = getAccounts();
    for (const acct of allAccounts) {
      if (acct.disabled || !acct.password) continue;
      if (!needsRefresh(acct)) continue;

      logStore.log('info', 'auth', `Background refresh: token expiring for ${acct.email}, refreshing...`);
      try {
        const ok = await ensureAccountFresh(acct);
        if (ok) {
          logStore.log('info', 'auth', `Background refresh: token renewed for ${acct.email}`);
        } else {
          logStore.log('warn', 'auth', `Background refresh: failed for ${acct.email}`);
        }
      } catch (err: any) {
        logStore.log('error', 'auth', `Background refresh error for ${acct.email}: ${err.message}`);
      }
    }
  };

  setInterval(tick, BACKGROUND_REFRESH_INTERVAL_MS).unref();
}
