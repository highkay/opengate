/*
 * File: loginService.ts
 * Login orchestration — tries browserless API login first (fastest, same stack as chat),
 * falls back to browser strategies when a Playwright session is available.
 * Extracted from auth.ts to break circular dependency between auth.ts and accountManager.ts.
 */

import crypto from 'node:crypto';
import type { AuthState } from '../types/auth.ts';
import {
  beginLoginFailureScope,
  clearLastLoginFailure,
  getLastLoginFailure,
  type LoginFailure,
  type LoginRetryOptions,
  loginFreshViaBrowser,
  loginFreshViaFetch,
  loginViaTempContext,
} from './loginHelpers.ts';
import { logStore } from './logStore.ts';
import { getActivePage, getBrowser, Mutex } from './playwright.ts';

export { clearLastLoginFailure, getLastLoginFailure, type LoginFailure };

const loginMutex = new Mutex();

export interface LoginOptions extends LoginRetryOptions {
  allowBrowserFallback?: boolean;
}

export async function loginFresh(email: string, password: string, options: LoginOptions = {}): Promise<AuthState | null> {
  beginLoginFailureScope(email);
  const hashedPassword = crypto.createHash('sha256').update(password).digest('hex');

  // Primary path: browserlessFetch (wreq + acw_tc + bx) — same transport as chat
  if (!process.env.TEST_MOCK_PLAYWRIGHT) {
    const fetchResult = await loginFreshViaFetch(email, hashedPassword, options);
    if (fetchResult) {
      logStore.log('info', 'auth', 'Login success (fetch): ' + email);
      return fetchResult;
    }
  }

  // Fallback to browser strategies if fetch fails and a browser session exists
  if (!process.env.TEST_MOCK_PLAYWRIGHT && options.allowBrowserFallback !== false) {
    const activePage = getActivePage();
    if (activePage) {
      const browserResult = await loginFreshViaBrowser(email, hashedPassword, loginMutex);
      if (browserResult) {
        clearLastLoginFailure(email);
        logStore.log('info', 'auth', 'Login success: ' + email);
        return browserResult;
      }
      logStore.log('warn', 'auth', `Browser login failed for ${email}, trying temp context...`);
    }

    const browser = getBrowser();
    if (browser) {
      const tempResult = await loginViaTempContext(browser, email, hashedPassword, loginMutex);
      if (tempResult) {
        clearLastLoginFailure(email);
        logStore.log('info', 'auth', 'Login success (temp context): ' + email);
        return tempResult;
      }
      logStore.log('warn', 'auth', `Temp context login failed for ${email}`);
    }
  }

  const failure = getLastLoginFailure(email);
  if (failure) {
    logStore.log('error', 'auth', `Login failed: ${email} [${failure.code}] ${failure.message}`);
  } else {
    logStore.log('error', 'auth', 'Login failed: ' + email);
  }
  return null;
}
