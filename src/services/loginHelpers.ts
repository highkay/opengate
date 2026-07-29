/*
 * File: loginHelpers.ts
 * Login implementation helpers extracted from auth.ts.
 * Contains the three login strategies: browser context, fetch, and temp context.
 */

import { AsyncLocalStorage } from 'node:async_hooks';
import crypto from 'crypto';
import type { AuthState } from '../types/auth.ts';
import { getAuthTokenMaxAgeMs } from './auth.ts';
import { browserlessFetch } from './browserlessFetch.ts';
import { logStore } from './logStore.ts';
import { AccountContext, createAccountContext, getActivePage, getBrowser, Mutex, removeAccountContext } from './playwright.ts';
import { createFetchTimeout } from './qwen.ts';

const QWEN_CHAT_URL = 'https://chat.qwen.ai';

/** Classified API-login failure for accurate UI / log messages. */
export type LoginFailureCode =
  | 'waf'
  | 'credentials'
  | 'not_registered'
  | 'http_error'
  | 'network'
  | 'empty_response'
  | 'no_token'
  | 'unknown';

export interface LoginFailure {
  code: LoginFailureCode;
  message: string;
  /** True when a limited backoff retry may help (WAF/network blips). */
  retryable: boolean;
}

interface LoginFailureScope {
  email: string;
}

const loginFailureScope = new AsyncLocalStorage<LoginFailureScope>();
const loginFailuresByEmail = new Map<string, LoginFailure>();

export function beginLoginFailureScope(email: string): void {
  const normalizedEmail = email.toLowerCase().trim();
  loginFailureScope.enterWith({ email: normalizedEmail });
  loginFailuresByEmail.delete(normalizedEmail);
}

export function getLastLoginFailure(email?: string): LoginFailure | null {
  const scopedEmail = email?.toLowerCase().trim() || loginFailureScope.getStore()?.email;
  if (scopedEmail) return loginFailuresByEmail.get(scopedEmail) ?? null;
  if (loginFailuresByEmail.size === 1) return loginFailuresByEmail.values().next().value ?? null;
  return null;
}

export function clearLastLoginFailure(email?: string): void {
  const scopedEmail = email?.toLowerCase().trim() || loginFailureScope.getStore()?.email;
  if (scopedEmail) loginFailuresByEmail.delete(scopedEmail);
}

function setLastLoginFailure(email: string, failure: LoginFailure): void {
  loginFailuresByEmail.set(email.toLowerCase().trim(), failure);
}

const API_LOGIN_MAX_ATTEMPTS = 3;
const API_LOGIN_BASE_DELAY_MS = 800;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export interface LoginRetryOptions {
  maxAttempts?: number;
  baseDelayMs?: number;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Detect Aliyun WAF / challenge HTML masquerading as a 200. Exported for tests. */
export function isWafResponseBody(bodyText: string, contentType: string | null | undefined): boolean {
  const ct = (contentType || '').toLowerCase();
  if (ct.includes('text/html')) return true;
  const trimmed = bodyText.trimStart().toLowerCase();
  if (trimmed.startsWith('<!doctype') || trimmed.startsWith('<html') || trimmed.startsWith('<head')) return true;
  if (/aliyun_waf/i.test(bodyText)) return true;
  if (/name=["']aliyun_waf_/i.test(bodyText)) return true;
  return false;
}

export function extractTokensFromSetCookie(response: Response): { token: string | null; refreshToken: string | null } {
  let token: string | null = null;
  let refreshToken: string | null = null;
  const hdrs = response.headers as Headers & { getSetCookie?: () => string[] };
  const setCookies: string[] =
    typeof hdrs.getSetCookie === 'function' ? hdrs.getSetCookie() : (response.headers.get('set-cookie') || '').split(/,(?=\s*[^;]+=)/);

  for (const cookie of setCookies) {
    if (!cookie) continue;
    const cookiePair = cookie.match(/^\s*([^=;,\s]+)=([^;]*)/);
    if (!cookiePair) continue;
    const name = cookiePair[1].toLowerCase();
    if (name === 'token' && !token) token = cookiePair[2];
    if (name === 'refresh_token') refreshToken = cookiePair[2];
  }
  return { token, refreshToken };
}

export function findAuthCookieValues(cookies: Array<{ name: string; value: string }>): {
  token: string | null;
  refreshToken: string | null;
} {
  const cookieMap = new Map(cookies.map((cookie) => [cookie.name.toLowerCase(), cookie.value]));
  return {
    token: cookieMap.get('token') ?? cookieMap.get('session_token') ?? cookieMap.get('access_token') ?? null,
    refreshToken: cookieMap.get('refresh_token') ?? null,
  };
}

function classifyBusinessFailure(data: any): LoginFailure | null {
  if (!data || typeof data !== 'object') return null;
  if (data.success === true) return null;

  const details = String(data?.data?.details || data?.details || data?.message || data?.error || '').trim();
  const code = String(data?.data?.code || data?.code || '').trim();
  const combined = `${code} ${details}`.toLowerCase();

  if (combined.includes('not registered') || combined.includes('sign up first')) {
    return {
      code: 'not_registered',
      message: details || 'Account is not registered on Qwen',
      retryable: false,
    };
  }
  if (
    combined.includes('password') ||
    combined.includes('credential') ||
    combined.includes('unauthorized') ||
    combined.includes('invalid') ||
    code === 'Unauthorized' ||
    code === 'Bad_Request'
  ) {
    // Bad_Request without "not registered" still often means credential/account issues
    return {
      code: 'credentials',
      message: details || code || 'Invalid credentials or account rejected by Qwen',
      retryable: false,
    };
  }
  if (data.success === false) {
    return {
      code: 'no_token',
      message: details || code || 'Qwen rejected sign-in (success=false, no token)',
      retryable: false,
    };
  }
  return null;
}

function failureFromThrown(err: unknown): LoginFailure {
  const msg = err instanceof Error ? err.message : String(err);
  const lower = msg.toLowerCase();
  if (
    lower.includes('waf') ||
    lower.includes('aliyun_waf') ||
    lower.includes('cookie refresh failed') ||
    lower.includes('challenge persists')
  ) {
    return {
      code: 'waf',
      message: `Blocked by Aliyun WAF during API login: ${msg}`,
      retryable: true,
    };
  }
  if (
    lower.includes('abort') ||
    lower.includes('timeout') ||
    lower.includes('timed out') ||
    lower.includes('network') ||
    lower.includes('econn')
  ) {
    return {
      code: 'network',
      message: `Network error during API login: ${msg}`,
      retryable: true,
    };
  }
  return {
    code: 'unknown',
    message: `API login error: ${msg}`,
    retryable: true,
  };
}

/**
 * Login via browser context — executes signin API inside the browser via evaluate().
 */
export async function loginFreshViaBrowser(email: string, hashedPassword: string, loginMutex: Mutex): Promise<AuthState | null> {
  const release = await loginMutex.acquire();
  try {
    const page = getActivePage();
    if (!page) return null;

    try {
      const currentUrl = page.url();
      if (!currentUrl.startsWith(QWEN_CHAT_URL)) {
        await page.goto(QWEN_CHAT_URL, { waitUntil: 'domcontentloaded' });
      }
    } catch (err: any) {
      logStore.log('warn', 'auth', `Navigation check failed for ${email}: ${err.message}`);
    }

    try {
      const context = page.context();
      const existingCookies = await context.cookies();
      const authCookies = existingCookies.filter((c) => c.name === 'token' || c.name === 'refresh_token');
      if (authCookies.length > 0) {
        // Only remove specific auth cookies, not ALL cookies
        for (const c of authCookies) {
          await context.clearCookies({ name: c.name, domain: c.domain, path: c.path });
        }
      }
    } catch (err: any) {
      logStore.log('warn', 'auth', `Cookie clearing failed for ${email}: ${err.message}`);
    }

    let evalResult: { ok: boolean; status: number; token: string | null; refreshToken: string | null; dataKeys: string[] };
    try {
      evalResult = await page.evaluate(
        async ({ email, hashedPassword }: { email: string; hashedPassword: string }) => {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 15_000);
          let response: Response;
          try {
            response = await fetch(`${QWEN_CHAT_URL}/api/v2/auths/signin`, {
              method: 'POST',
              headers: {
                accept: 'application/json, text/plain, */*',
                'content-type': 'application/json',
                source: 'web',
                timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
                'x-request-id': crypto.randomUUID(),
              },
              credentials: 'include',
              body: JSON.stringify({ email, password: hashedPassword }),
              signal: controller.signal,
            });
          } finally {
            clearTimeout(timeoutId);
          }

          let data: any = {};
          try {
            data = await response.json();
          } catch {
            // non-blocking: non-JSON responses fall back to empty data
          }

          const token = data?.data?.token || data?.token || data?.data?.session_token || null;
          const refreshToken = data?.data?.refresh_token || data?.refresh_token || null;

          return {
            ok: response.ok,
            status: response.status,
            token: token as string | null,
            refreshToken: refreshToken as string | null,
            dataKeys: Object.keys(data),
          };
        },
        { email, hashedPassword },
      );
    } catch (err: any) {
      logStore.log('error', 'auth', `Browser evaluate failed for ${email}: ${err.message}`);
      return null;
    }

    if (!evalResult.ok) {
      logStore.log('error', 'auth', `Login failed for ${email} (${evalResult.status})`);
      return null;
    }

    let cookieToken: string | null = null;
    let cookieRefresh: string | null = null;
    try {
      const cookies = await page.context().cookies();
      const authCookies = findAuthCookieValues(cookies);
      cookieToken = authCookies.token;
      cookieRefresh = authCookies.refreshToken;
    } catch (err: any) {
      logStore.log('warn', 'auth', `Cookie read failed for ${email}: ${err.message}`);
    }

    const finalToken = evalResult.token || cookieToken;
    const finalRefresh = evalResult.refreshToken || cookieRefresh;

    if (finalToken) {
      return {
        token: finalToken,
        expiresAt: Date.now() + getAuthTokenMaxAgeMs(),
        refreshToken: finalRefresh,
      };
    }

    logStore.log(
      'warn',
      'auth',
      `Login returned 200 for ${email} but no token found. ` +
        `Response keys: [${evalResult.dataKeys.join(', ')}]. ` +
        `No auth cookies captured.`,
    );
    return null;
  } finally {
    release();
  }
}

/**
 * Single attempt: sign-in via browserlessFetch (wreq + acw_tc + bx headers).
 * Same transport stack as chat — not bare global fetch.
 */
async function loginFreshViaFetchOnce(
  email: string,
  hashedPassword: string,
): Promise<{ state: AuthState | null; failure: LoginFailure | null }> {
  const { controller, cleanup } = createFetchTimeout();
  try {
    const response = await browserlessFetch(`${QWEN_CHAT_URL}/api/v2/auths/signin`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/json',
        source: 'web',
        Version: '0.2.57',
        Referer: `${QWEN_CHAT_URL}/auth`,
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        'x-request-id': crypto.randomUUID(),
      },
      body: JSON.stringify({ email, password: hashedPassword }),
      signal: controller.signal,
      accountEmail: email,
    });

    const contentType = response.headers.get('content-type');
    const rawText = await response.text();

    if (isWafResponseBody(rawText, contentType)) {
      return {
        state: null,
        failure: {
          code: 'waf',
          message: `Aliyun WAF challenge on sign-in (HTTP ${response.status}, content-type=${contentType || 'unknown'})`,
          retryable: true,
        },
      };
    }

    let data: any = {};
    if (rawText.trim()) {
      try {
        data = JSON.parse(rawText);
      } catch {
        return {
          state: null,
          failure: {
            code: 'empty_response',
            message: `Non-JSON sign-in response (HTTP ${response.status}): ${rawText.substring(0, 120)}`,
            retryable: true,
          },
        };
      }
    } else if (response.ok) {
      // Empty body with 200 — historically logged as {} and mislabeled as CAPTCHA
      const fromCookie = extractTokensFromSetCookie(response);
      if (fromCookie.token) {
        return {
          state: {
            token: fromCookie.token,
            expiresAt: Date.now() + getAuthTokenMaxAgeMs(),
            refreshToken: fromCookie.refreshToken,
          },
          failure: null,
        };
      }
      return {
        state: null,
        failure: {
          code: 'empty_response',
          message: `Empty sign-in body (HTTP ${response.status}) — not a credential error`,
          retryable: true,
        },
      };
    }

    if (!response.ok) {
      const business = classifyBusinessFailure(data);
      if (business) return { state: null, failure: business };
      return {
        state: null,
        failure: {
          code: 'http_error',
          message: `Sign-in HTTP ${response.status}: ${rawText.substring(0, 160)}`,
          retryable: response.status >= 500 || response.status === 429,
        },
      };
    }

    const businessFail = classifyBusinessFailure(data);
    // success:false with details → definitive business failure (no token expected)
    if (businessFail && data?.success === false) {
      return { state: null, failure: businessFail };
    }

    let token = data?.data?.token || data?.token || data?.data?.session_token || null;
    let refreshToken = data?.data?.refresh_token || data?.refresh_token || null;

    if (!token) {
      const fromCookie = extractTokensFromSetCookie(response);
      if (fromCookie.token) token = fromCookie.token;
      if (fromCookie.refreshToken) refreshToken = fromCookie.refreshToken;
    }

    if (token) {
      return {
        state: {
          token,
          expiresAt: Date.now() + getAuthTokenMaxAgeMs(),
          refreshToken,
        },
        failure: null,
      };
    }

    if (businessFail) {
      return { state: null, failure: businessFail };
    }

    const summary = data && typeof data === 'object' ? JSON.stringify(data).substring(0, 200) : String(data).substring(0, 200);
    return {
      state: null,
      failure: {
        code: 'no_token',
        message: `Sign-in returned HTTP ${response.status} but no token: ${summary || '(empty)'}`,
        retryable: false,
      },
    };
  } catch (err: unknown) {
    return { state: null, failure: failureFromThrown(err) };
  } finally {
    cleanup();
  }
}

/**
 * Login via browserlessFetch (wreq TLS + acw_tc + bx) with limited backoff retries.
 * Retries only WAF / network / transient HTTP failures — never credential errors.
 */
export async function loginFreshViaFetch(
  email: string,
  hashedPassword: string,
  retryOptions: LoginRetryOptions = {},
): Promise<AuthState | null> {
  beginLoginFailureScope(email);
  let lastFailure: LoginFailure | null = null;
  const maxAttempts = retryOptions.maxAttempts ?? API_LOGIN_MAX_ATTEMPTS;
  const baseDelayMs = retryOptions.baseDelayMs ?? API_LOGIN_BASE_DELAY_MS;
  const random = retryOptions.random ?? Math.random;
  const wait = retryOptions.sleep ?? sleep;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const { state, failure } = await loginFreshViaFetchOnce(email, hashedPassword);
    if (state) {
      clearLastLoginFailure();
      if (attempt > 1) {
        logStore.log('info', 'auth', `API login succeeded for ${email} on attempt ${attempt}/${maxAttempts}`);
      }
      return state;
    }

    lastFailure = failure;
    const canRetry = !!failure?.retryable && attempt < maxAttempts;
    if (!canRetry) break;

    const delay = baseDelayMs * 2 ** (attempt - 1) + Math.floor(random() * 250);
    logStore.log(
      'warn',
      'auth',
      `API login attempt ${attempt}/${maxAttempts} failed for ${email} (${failure?.code}): ${failure?.message}. Retrying in ${delay}ms...`,
    );
    await wait(delay);
  }

  if (lastFailure) {
    setLastLoginFailure(email, lastFailure);
    logStore.log('warn', 'auth', `API login failed for ${email} [${lastFailure.code}]: ${lastFailure.message}`);
  } else {
    const fallback: LoginFailure = {
      code: 'unknown',
      message: 'API login failed with no classified reason',
      retryable: false,
    };
    setLastLoginFailure(email, fallback);
    logStore.log('warn', 'auth', `API login failed for ${email}: ${fallback.message}`);
  }

  return null;
}

export async function loginViaTempContext(
  _browser: ReturnType<typeof getBrowser>,
  email: string,
  hashedPassword: string,
  loginMutex: Mutex,
): Promise<AuthState | null> {
  const release = await loginMutex.acquire();
  let accCtx: AccountContext | null = null;
  try {
    accCtx = await createAccountContext(email);
    const page = accCtx.page;
    const context = accCtx.context;

    let capturedToken: string | null = null;
    let capturedRefresh: string | null = null;

    // Intercept signin API to capture token from BOTH JSON body AND set-cookie headers
    await page.route('**/api/v2/auths/signin', async (route) => {
      try {
        const response = await route.fetch();

        // Try to extract token from JSON response body first (fastest path)
        try {
          const body = await response.json();
          const jsonToken = body?.data?.token || body?.token || body?.data?.session_token || null;
          const jsonRefresh = body?.data?.refresh_token || body?.refresh_token || null;
          if (jsonToken && !capturedToken) capturedToken = jsonToken;
          if (jsonRefresh && !capturedRefresh) capturedRefresh = jsonRefresh;
        } catch {
          logStore.log('warn', 'auth', 'signin route fetch returned non-JSON response');
        }

        // Also check set-cookie headers as fallback
        const setCookies = response
          .headersArray()
          .filter((h) => h.name.toLowerCase() === 'set-cookie')
          .map((h) => h.value);
        for (const cookie of setCookies) {
          const tokenMatch = cookie.match(/\btoken=([^;]+)/);
          if (tokenMatch && !capturedToken) capturedToken = tokenMatch[1];
          const refreshMatch = cookie.match(/\brefresh_token=([^;]+)/);
          if (refreshMatch && !capturedRefresh) capturedRefresh = refreshMatch[1];
        }

        await route.fulfill({ response });
      } catch {
        // If route.fetch fails, let the request pass through normally
        await route.continue();
      }
    });

    try {
      await page.goto(`${QWEN_CHAT_URL}/auth`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
    } catch {
      logStore.log('warn', 'auth', `goto auth page failed for ${email}`);
    }

    try {
      await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 10_000 });
      await page.fill('input[type="email"], input[name="email"]', email);
      await page.fill('input[type="password"], input[name="password"]', hashedPassword);
      await Promise.all([
        page.click('button[type="submit"], button:has-text("Sign in"), button:has-text("Log in"), button:has-text("Continue")'),
        page.waitForURL((url) => !url.toString().includes('/auth'), { timeout: 15_000 }).catch(() => {}),
      ]);
    } catch {
      logStore.log('warn', 'auth', `form fill/submit failed for ${email}`);
    }

    // Poll for token with shorter intervals instead of blind sleep
    for (let attempt = 0; attempt < 10; attempt++) {
      if (capturedToken) break;
      await new Promise((r) => setTimeout(r, 500));

      // Check cookies as fallback
      try {
        const cookies = await context.cookies();
        const authCookies = findAuthCookieValues(cookies);
        if (authCookies.token) capturedToken = authCookies.token;
        if (authCookies.refreshToken) capturedRefresh = authCookies.refreshToken;
      } catch {
        logStore.log('warn', 'auth', `cookie read failed during poll for ${email}`);
      }
    }

    await page.unroute('**/api/v2/auths/signin');

    if (capturedToken) {
      return {
        token: capturedToken,
        expiresAt: Date.now() + getAuthTokenMaxAgeMs(),
        refreshToken: capturedRefresh,
      };
    }

    const cookies = await context.cookies();
    logStore.log('warn', 'auth', `Temp context login failed for ${email}. Cookies: ${cookies.map((c) => c.name).join(', ')}`);
    return null;
  } catch (err: any) {
    logStore.log('error', 'auth', `Temp context login error for ${email}: ${err.message}`);
    return null;
  } finally {
    // Close the temp context to prevent BrowserContext leak. Each loginViaTempContext
    // call creates a new page+context via createAccountContext — without closing it,
    // contexts accumulate in the Playwright browser process, wasting memory.
    if (accCtx) {
      try {
        removeAccountContext(email);
      } catch {
        /* removeAccountContext handles interval clear, context close, and map cleanup */
      }
      try {
        await accCtx.page.close();
      } catch {
        /* page may already be closed */
      }
      try {
        await accCtx.context.close();
      } catch {
        /* context may already be closed or already closed by removeAccountContext */
      }
    }
    release();
  }
}
