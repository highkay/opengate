/*
 * File: tokenRefresh.ts
 * Token refresh logic extracted from auth.ts.
 * Handles refresh token exchange and ensuring accounts stay fresh.
 */

import type { AccountEntry } from '../types/auth.ts';
import { getAuthRefreshBeforeMs, saveCookies } from './auth.ts';
import { browserlessFetch } from './browserlessFetch.ts';
import { loginFresh } from './loginService.ts';
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

export async function ensureAccountFresh(acct: AccountEntry): Promise<boolean> {
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

      const newState = await loginFresh(acct.email, acct.password);
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
