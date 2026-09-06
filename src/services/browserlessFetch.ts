/**
 * browserlessFetch — browserless requests to Qwen API with anti-WAF header stack.
 *
 * PRIMARY TRANSPORT: Bun native fetch (globalThis.fetch). Verified 2026-08-04 to
 * pass Aliyun WAF with the full bx/acw_tc header stack — signin, chats/new and
 * chat/completions all return 200 (success) when direct.
 *
 * LEGACY TRANSPORT: wreq-js worker (chrome_142 fingerprint via Rust + BoringSSL).
 * Aliyun WAF now flags this fingerprint and returns a 200 + punish JSON body
 * ({"rgv587_flag":"sm",...}), which the old wafCheck() missed because it only
 * looked at 302/403/200+text/html. Kept behind QWEN_TRANSPORT=wreq for A/B
 * comparison / rollback.
 *
 * Header stack (same for both transports):
 *   - bx-umidtoken: auto-extracted from sg-wum.alibaba.com + cached (4h TTL)
 *   - bx-v / bx-et: static anti-bot headers
 *   - bx-ua / bx-pp: generated per request
 *   - acw_tc cookie: from the chat.qwen.ai root page, refreshed periodically
 *
 * WAF/punish detection covers 302 / 403 / 200+text/html AND 200+JSON punish
 * bodies (rgv587_flag / bixi.alicdn.com/punish / RGV587_ERROR /
 * FAIL_SYS_USER_VALIDATE). WAF responses trigger acw_tc refresh + one retry;
 * if still WAF, the native transport fails fast (an IP-level block — baxia
 * punish or the aliyun_waf JS challenge page — cannot be cleared by a browser
 * from the same IP). Playwright cookie recovery remains only for the legacy
 * wreq transport (QWEN_TRANSPORT=wreq).
 */

import { logCrash, logEvent, logFetchCall } from '../utils/wreqCrashLogger.ts';
import { mergeCookieHeaders } from './browserRuntime.ts';
import { BX_UMIDTOKEN_TTL_MS, extractBxUmidtoken } from './bxTokenExtractor.ts';
import { generateBxPp, generateBxUa, refreshCookiesViaBrowser } from './fireyejsRunner.ts';
import { logStore } from './logStore.ts';
import { getAccountProxy, markProxyFailed } from './proxyManager.ts';
import { QWEN_API_BASE } from './qwen.ts';
import { tokenCache } from './tokenCache.ts';
import { disposeWreqWorker, wreqFetch } from './wreqFetch.ts';

// Single-flight guard: one cookie refresh per account at a time
const cookieRefreshInFlight = new Map<string, Promise<string | null>>();
const BX_UA_TTL_MS = 15 * 60 * 1000;
const ACW_TC_REFRESH_MS = 15 * 60 * 1000; // 15 minutes

/** Aliyun baxia punish / challenge markers appearing in 200-OK JSON bodies. */
const PUNISH_PATTERN = /rgv587_flag|bixi\.alicdn\.com\/punish|RGV587_ERROR|FAIL_SYS_USER_VALIDATE/;

/** Transport selection: native Bun fetch by default; wreq only when forced via env. */
function isNativeTransport(): boolean {
  return process.env.QWEN_TRANSPORT !== 'wreq';
}

/**
 * Normalize a proxy for the native transport. Bun's fetch `proxy` option only
 * accepts http(s) proxies; a socks5 proxy is ignored (direct) with a warning —
 * direct connections are verified to pass the WAF, socks5/WARP exits are not.
 */
function normalizeProxy(proxy?: string): string | undefined {
  if (!proxy) return undefined;
  if (/^https?:\/\//i.test(proxy)) return proxy;
  logStore.log('warn', 'browserless', `proxy ${proxy} unsupported by native transport — falling back to direct`);
  return undefined;
}

/** Bun native fetch with optional http(s) proxy. */
async function nativeFetch(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal; proxy?: string },
): Promise<Response> {
  const { method = 'GET', headers = {}, body, signal, proxy } = options;
  const fetchInit: RequestInit = { method, headers, body, signal };
  const normalized = normalizeProxy(proxy);
  if (normalized) (fetchInit as any).proxy = normalized;
  return globalThis.fetch(url, fetchInit);
}

/** Shared dispatch: native fetch (default) or legacy wreq worker. */
async function transportFetch(
  url: string,
  options: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal; stream?: boolean; proxy?: string },
): Promise<Response> {
  const { method = 'GET', headers = {}, body, signal, stream = false, proxy } = options;
  if (isNativeTransport()) {
    return nativeFetch(url, { method, headers, body, signal, proxy });
  }
  return wreqFetch(url, {
    method,
    headers,
    body,
    signal,
    stream,
    debugLogDir: process.env.DEBUG_IMPERS_DIR,
    proxy,
  });
}

/** Ensure bx-umidtoken is in headers, fetching from cache or sg-wum endpoint. */
async function ensureBxUmidtoken(headers: Record<string, string>, proxy?: string, accountEmail?: string): Promise<void> {
  if (headers['bx-umidtoken']) return;
  const cacheKey = accountEmail ? `bx-umidtoken:${accountEmail}` : 'bx-umidtoken';
  const token = await tokenCache.getOrSet(cacheKey, () => extractBxUmidtoken(proxy), BX_UMIDTOKEN_TTL_MS);
  headers['bx-umidtoken'] = token;
}

// ─── acw_tc cookie (Alibaba WAF) ────────────────────────────────────────────

/** Cache key per transport path: the acw_tc cookie is bound to the exit IP, so
 * the login proxy's acw_tc must never leak into the direct chat path's cache. */
function acwTcCacheKey(proxy?: string): string {
  return proxy ? `acw_tc:proxy:${proxy}` : 'acw_tc';
}

let acwTcRefreshTimer: ReturnType<typeof setInterval> | null = null;
/** Per-proxy-path single-flight: acw_tc is bound to the exit IP, so a cookie
 * minted on account A's proxy must NEVER be handed to account B's refresh or
 * injected into B's requests (cross-IP cookie = pointless + extra punishment). */
const acwTcRefreshInFlight = new Map<string, Promise<string | null>>();

/**
 * Fetch acw_tc cookie from the Qwen root page via native fetch.
 * Single-flight keyed by proxy path: concurrent callers (immediate ensure +
 * preload timer) on the SAME path share one root request — back-to-back root
 * GETs just before an API POST were observed to trip the WAF into resetting
 * the connection (ECONNRESET on signin).
 */
function refreshAcwTcCookie(proxy?: string): Promise<string | null> {
  const key = acwTcCacheKey(proxy);
  const existing = acwTcRefreshInFlight.get(key);
  if (existing) return existing;
  const flight = doRefreshAcwTcCookie(proxy).finally(() => {
    acwTcRefreshInFlight.delete(key);
  });
  acwTcRefreshInFlight.set(key, flight);
  return flight;
}
async function doRefreshAcwTcCookie(proxy?: string): Promise<string | null> {
  try {
    logEvent('refreshAcwTcCookie', 'fetching acw_tc from root');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('acw_tc refresh timed out')), 15_000);
    try {
      const resp = await nativeFetch(QWEN_API_BASE, {
        method: 'GET',
        headers: { accept: 'text/html,application/xhtml+xml' },
        signal: controller.signal,
        proxy,
      });
      logFetchCall('refreshAcwTcCookie', QWEN_API_BASE, 'GET', resp.status);
      let acwTc: string | null = null;
      const setCookie = resp.headers.get('set-cookie');
      if (setCookie && setCookie.includes('acw_tc=')) {
        const match = setCookie.match(/acw_tc=([^;]+)/);
        if (match) acwTc = match[1];
      }
      if (acwTc) {
        tokenCache.set(acwTcCacheKey(proxy), acwTc, ACW_TC_REFRESH_MS * 2);
        logStore.log('debug', 'browserless', 'acw_tc cookie refreshed');
        logEvent('refreshAcwTcCookie', 'acw_tc obtained');
      } else {
        logEvent('refreshAcwTcCookie', 'no acw_tc in response');
      }
      return acwTc;
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logStore.log('warn', 'browserless', `acw_tc refresh failed: ${msg}`);
    logCrash('refreshAcwTcCookie', err);
    return null;
  }
}

/** Start periodic acw_tc refresh (idempotent). */
function startAcwTcRefresh(): void {
  if (acwTcRefreshTimer) return;
  setTimeout(() => {
    refreshAcwTcCookie().catch(() => {});
  }, 1000);
  acwTcRefreshTimer = setInterval(() => {
    refreshAcwTcCookie().catch(() => {});
  }, ACW_TC_REFRESH_MS);
}

/** Inject acw_tc cookie into headers from cache. */
async function ensureAcwTcCookie(headers: Record<string, string>, proxy?: string): Promise<void> {
  startAcwTcRefresh();

  let acwTc = tokenCache.get(acwTcCacheKey(proxy)) ?? null;
  if (!acwTc) {
    acwTc = await refreshAcwTcCookie(proxy);
  }
  if (acwTc) {
    headers['cookie'] = mergeCookieHeaders(headers['cookie'], `acw_tc=${acwTc}`);
  }
}

// ─── WAF / punish check ─────────────────────────────────────────────────────

const isPunishText = (text: string): boolean => PUNISH_PATTERN.test(text);

interface WafCheck {
  waf: boolean;
  /** Diagnostic only: true when body is baxia punish JSON (rgv587_flag/...) vs the aliyun_waf JS challenge page or 302/403. */
  punish: boolean;
  response: Response;
}

/**
 * Detect WAF/punish responses. 302/403 are always WAF. 200 responses are WAF
 * when HTML, and — for non-stream requests — when the JSON body carries a
 * punish marker (200+JSON punish was the exact failure mode of the wreq era).
 *
 * `punish` is a diagnostic flag (baxia punish JSON). The recovery decision is
 * transport-level in browserlessFetch, not punish-level.
 *
 * When the body must be consumed to decide, the response is reconstructed so
 * callers can still read it.
 */
async function wafCheckResponse(response: Response, stream: boolean): Promise<WafCheck> {
  if (response.status === 302 || response.status === 403) return { waf: true, punish: false, response };
  const ct = response.headers.get('content-type') || '';

  if (stream) {
    if (ct.includes('text/html')) return { waf: true, punish: false, response };
    if (ct.includes('text/event-stream')) return { waf: false, punish: false, response };
    // JSON (or unknown) on a stream request — consume and classify (small payload)
    try {
      const text = await response.text();
      if (isPunishText(text)) return { waf: true, punish: true, response };
      return {
        waf: false,
        punish: false,
        response: new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers }),
      };
    } catch {
      return { waf: false, punish: false, response };
    }
  }

  if (response.status === 200 && ct.includes('text/html')) return { waf: true, punish: false, response };
  if (ct.includes('application/json')) {
    try {
      const text = await response.text();
      if (isPunishText(text)) return { waf: true, punish: true, response };
      return {
        waf: false,
        punish: false,
        response: new Response(text, { status: response.status, statusText: response.statusText, headers: response.headers }),
      };
    } catch {
      return { waf: false, punish: false, response };
    }
  }
  return { waf: false, punish: false, response };
}

export interface BrowserlessFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  accountEmail?: string;
  signal?: AbortSignal;
  stream?: boolean;
  allowBrowserRecovery?: boolean;
  proxy?: string;
}

/**
 * Default proxy for business (chat) traffic. Login/signin/refresh passes its
 * own explicit proxy (QWEN_LOGIN_PROXY); business calls (chats/new,
 * chat/completions, uploads, delete) used to go direct from the host IP.
 * Route them through the same rotating exit IP so Aliyun WAF's IP-level
 * frequency control sees a distributed source instead of one hot host IP.
 */
function defaultBusinessProxy(): string | undefined {
  return process.env.QWEN_CHAT_PROXY || process.env.QWEN_PROXY || process.env.QWEN_LOGIN_PROXY || undefined;
}

/**
 * Make a browserless request to the Qwen API.
 *
 * Returns a standard Web API Response object.
 * Use `response.body.getReader()` for SSE streaming.
 */
export async function browserlessFetch(url: string, options: BrowserlessFetchOptions = {}): Promise<Response> {
  if (process.env.TEST_MOCK_PLAYWRIGHT) {
    const { method = 'GET', headers = {}, body } = options;
    return globalThis.fetch(url, { method, headers, body });
  }

  const { method = 'GET', headers = {}, body, accountEmail, signal, stream, allowBrowserRecovery = true } = options;
  const proxy = options.proxy ?? (accountEmail ? getAccountProxy(accountEmail) : defaultBusinessProxy());

  // Auto-inject bx tokens (pure header builders — network-dependent token
  // fetches run inside the guarded try below, see the note there)

  if (!headers['bx-v']) headers['bx-v'] = '2.5.36';
  if (!headers['bx-et']) headers['bx-et'] = 'nosgn';

  if (!headers['bx-ua']) {
    const uaCacheKey = accountEmail ? `bx-ua:${accountEmail}` : 'bx-ua';
    const cached = tokenCache.get(uaCacheKey);
    if (cached) {
      headers['bx-ua'] = cached;
    } else {
      try {
        const generated = await generateBxUa();
        if (generated) {
          headers['bx-ua'] = generated;
          tokenCache.set(uaCacheKey, generated, BX_UA_TTL_MS);
        }
      } catch {
        /* fallback */
      }
    }
    if (!headers['bx-ua']) {
      headers['bx-ua'] = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
    }
  }

  if (!headers['bx-pp']) {
    try {
      const pp = await generateBxPp(body);
      if (pp) headers['bx-pp'] = pp;
    } catch {
      /* optional */
    }
  }

  const startTime = Date.now();

  // ─── Initial request ───────────────────────────────────────────────
  try {
    // Auto-inject network tokens INSIDE the guarded region: a stuck/dead
    // sticky bind (timeout, refused, EOF) must reach the catch below and
    // trigger markProxyFailed so the account rebinds to a fresh exit IP —
    // otherwise the account keeps its dead sticky URL forever (same resin
    // username → same node).
    await ensureBxUmidtoken(headers, proxy, accountEmail);
    await ensureAcwTcCookie(headers, proxy);
    logFetchCall('browserlessFetch', url, method);
    let response = await transportFetch(url, {
      method,
      headers,
      body,
      signal,
      stream: !!stream,
      proxy,
    });
    logFetchCall('browserlessFetch', url, method, response.status);

    // ─── WAF detection + recovery ─────────────────────────────────────
    let check = await wafCheckResponse(response, !!stream);
    response = check.response;
    if (check.waf) {
      logEvent('browserlessFetch', 'WAF detected', { url: url.split('?')[0], status: response.status, punish: check.punish });
      logStore.log('warn', 'browserless', `WAF detected on ${url.split('?')[0]} — trying HTTP refresh first...`);
      const currentCookie = headers['cookie'] || '';
      let needsBrowserRefresh = true;

      const freshAcwTc = await refreshAcwTcCookie(proxy);
      const sentAcwTc = currentCookie.match(/acw_tc=([^;]+)/)?.[1] ?? null;
      // Native transport: the refresh reuses the same sticky exit IP, so a
      // same-IP retry can only pass when the WAF actually re-issued a NEW
      // cookie. A null/stale cookie means the IP itself is flagged — retrying
      // just adds traffic that extends the punishment. Fail fast instead;
      // markProxyFailed in the branch below rebinds to a fresh exit IP.
      const canRetrySameIp = !isNativeTransport() || (freshAcwTc !== null && freshAcwTc !== sentAcwTc);
      if (canRetrySameIp && freshAcwTc) {
        headers['cookie'] = mergeCookieHeaders(currentCookie, `acw_tc=${freshAcwTc}`);
        logEvent('browserlessFetch', 'HTTP cookie retry', { url: url.split('?')[0] });
        response = await transportFetch(url, {
          method,
          headers,
          body,
          signal,
          stream: !!stream,
          proxy,
        });
        logFetchCall('browserlessFetch.http-cookie-retry', url, method, response.status);
        const after = await wafCheckResponse(response, !!stream);
        response = after.response;
        needsBrowserRefresh = after.waf;
      }

      if (needsBrowserRefresh) {
        if (!allowBrowserRecovery) {
          throw new Error(`WAF challenge persists after HTTP cookie refresh for ${url.split('?')[0]}; browser recovery disabled`);
        }
        // Native fetch passes the WAF whenever the IP is clean (verified
        // repeatedly — signin/chats/new/chat/completions all 200 direct). A WAF
        // response that survives the HTTP acw_tc refresh is therefore an
        // IP-level block — baxia punish JSON (rgv587_flag) or the aliyun_waf
        // JS challenge page (200 + text/html) — that a Playwright browser from
        // the same IP cannot clear: 10+ browser recoveries in production, 0
        // successes. Escalating only adds traffic that extends the punishment.
        // Fail fast so the auth loop backs off and the IP can cool down.
        // Playwright recovery stays for the legacy wreq transport only.
        if (isNativeTransport()) {
          if (accountEmail) markProxyFailed(accountEmail);
          throw new Error(
            `Aliyun WAF challenge persists after HTTP cookie refresh for ${url.split('?')[0]}; skipping browser recovery (native transport) — IP needs cooldown`,
          );
        }
        logStore.log('warn', 'browserless', `HTTP refresh failed — trying Playwright browser...`);
        const key = accountEmail || '_default_';
        let promise = cookieRefreshInFlight.get(key);
        if (!promise) {
          promise = refreshCookiesViaBrowser(currentCookie).finally(() => {
            cookieRefreshInFlight.delete(key);
          });
          cookieRefreshInFlight.set(key, promise);
        }
        const freshCookies = await promise;
        if (freshCookies) {
          headers['cookie'] = mergeCookieHeaders(currentCookie, headers['cookie'], freshCookies);
          tokenCache.delete(accountEmail ? `bx-ua:${accountEmail}` : 'bx-ua');
          tokenCache.delete(acwTcCacheKey(proxy));
          await ensureBxUmidtoken(headers, proxy, accountEmail);
          headers['bx-ua'] = (await generateBxUa()) || headers['bx-ua'];
          const pp = await generateBxPp(body);
          if (pp) headers['bx-pp'] = pp;
          logStore.log('info', 'browserless', `Retrying ${url.split('?')[0]} with fresh cookies...`);

          logEvent('browserlessFetch', 'WAF retry', { url: url.split('?')[0] });
          logFetchCall('browserlessFetch.retry', url, method);
          response = await transportFetch(url, {
            method,
            headers,
            body,
            signal,
            stream: !!stream,
            proxy,
          });
          logFetchCall('browserlessFetch.retry', url, method, response.status);
          const after = await wafCheckResponse(response, !!stream);
          response = after.response;
          if (after.waf) {
            // WAF persists after full recovery — mark proxy as failed so next
            // request gets a fresh proxy (new sticky session → new exit IP).
            if (accountEmail) markProxyFailed(accountEmail);
            throw new Error(`WAF challenge persists after cookie refresh for ${url.split('?')[0]}`);
          }
        }
        if (!freshCookies) {
          throw new Error(`Cookie refresh failed for ${url.split('?')[0]} — cannot retry`);
        }
      }
    }

    const elapsed = Date.now() - startTime;
    logStore.log('debug', 'browserless', `${method} ${url.split('?')[0]} → ${response.status} (${elapsed}ms)`);

    // For streaming: stash noop close function so qwen.ts doesn't break
    if (stream) {
      (response as any)._wreqClose = () => {
        // Worker creates fresh session per request — nothing to close.
      };
      return response;
    }

    return response;
  } catch (err) {
    const elapsed = Date.now() - startTime;
    const msg = err instanceof Error ? err.message : String(err);

    // Classify crash type for easier analysis
    const errStr = msg.toLowerCase();
    if (errStr.includes('waf') || errStr.includes('aliyun_waf') || errStr.includes('403') || errStr.includes('302')) {
      logEvent('browserlessFetch', 'WAF error', { url: url.split('?')[0], method, error: msg.substring(0, 200), elapsed_ms: elapsed });
    } else {
      logCrash('browserlessFetch', err, { url: url.split('?')[0], method, elapsed_ms: elapsed });
    }

    logStore.log('warn', 'browserless', `${method} ${url.split('?')[0]} failed after ${elapsed}ms: ${msg}`);

    if (msg.includes('403') || msg.includes('FAIL_SYS_USER_VALIDATE')) {
      tokenCache.delete(accountEmail ? `bx-umidtoken:${accountEmail}` : 'bx-umidtoken');
    }

    // Network-level failure (proxy down, tunnel error, EOF, timeout) — the proxy
    // is degraded; mark it so the next request rebinds to a fresh sticky IP.
    if (accountEmail && !errStr.includes('waf') && !errStr.includes('aliyun_waf') && !errStr.includes('302')) {
      markProxyFailed(accountEmail);
    }

    throw err;
  }
}

/** Dispose the wreq worker process. Call on app shutdown. */
export async function disposeSession(_accountEmail?: string): Promise<void> {
  await disposeWreqWorker();
}
