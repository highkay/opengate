/**
 * proxyManager — per-account sticky proxy binding, probe, and lifecycle.
 *
 * Design:
 * - Each account gets a dedicated proxy URL with its name embedded:
 *   http://Default.{sanitized_email}:password@host:port
 * - The proxy provider uses the {account} segment as a "sticky session" key,
 *   pinning the same exit IP for the life of that session ID.
 * - When a proxy fails (WAF punish, network error), markProxyFailed() clears
 *   the binding; the next call to getAccountProxy() builds a fresh URL
 *   (new session → new exit IP).
 * - Probe verifies basic proxy connectivity + acw_tc acquisition at startup.
 */

import { accounts, getAccountByEmail, saveAccountsToFile } from './accountManager.ts';
import { logStore } from './logStore.ts';
import { tokenCache } from './tokenCache.ts';

const PROBE_TIMEOUT_MS = 15_000;
const PROBE_CONCURRENCY = 2;

// ─── Proxy template helpers ─────────────────────────────────────────────────

/** Parse the base proxy URL into template components. */
function parseBaseProxy(): { protocol: string; password: string; hostport: string } | null {
  const proxy = process.env.QWEN_CHAT_PROXY || process.env.QWEN_PROXY || process.env.QWEN_LOGIN_PROXY || '';
  if (!proxy) return null;
  const match = proxy.match(/^(https?:\/\/)([^:]+):([^@]+)@(.+)$/);
  if (!match) return null;
  return { protocol: match[1], password: match[3], hostport: match[4] };
}

/**
 * Sanitize an email address for use as a proxy username segment.
 * "tmppowpwl7673@highkay.qzz.io" → "tmppowpwl7673"
 */
export function sanitizeEmail(email: string): string {
  return email.split('@')[0].replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Build a sticky proxy URL for a specific account.
 *
 * epoch=0: http://Default.{sanitized}:password@host:port
 * epoch>0: http://Default.{sanitized}-e{epoch}:password@host:port
 *
 * The epoch suffix is the "session" the proxy provider keys stickiness on:
 * same suffix → same exit IP for the session lifetime; a different suffix →
 * a brand-new IP assignment. Rebinding after a failure therefore bumps the
 * epoch so the account gets a fresh IP instead of the degraded one.
 */
export function buildAccountProxy(email: string, epoch = 0): string | null {
  const parsed = parseBaseProxy();
  if (!parsed) return null;
  const safe = sanitizeEmail(email);
  const session = epoch > 0 ? `${safe}-e${epoch}` : safe;
  return `${parsed.protocol}Default.${session}:${parsed.password}@${parsed.hostport}`;
}

/** Extract the epoch suffix from a proxy URL (for diagnostics/tests). */
export function proxyEpochOf(url: string): number {
  const match = url.match(/-e(\d+):/);
  return match ? Number(match[1]) : 0;
}

// ─── Account proxy binding ──────────────────────────────────────────────────

/**
 * Resolve the proxy URL for an account.
 *
 * - If the account has a `proxyUrl` and it has NOT been marked failed → reuse it.
 * - Otherwise → rebind: bump epoch, build a fresh URL (new session → new IP).
 * - Falls back to defaultBusinessProxy() when no template proxy is configured.
 */
export function getAccountProxy(email: string): string | undefined {
  const acct = getAccountByEmail(email);

  if (acct?.proxyUrl && !acct.proxyFailed) {
    return acct.proxyUrl;
  }

  const epoch = acct?.proxyEpoch ?? 0;
  const newProxy = buildAccountProxy(email, epoch);
  if (newProxy && acct) {
    acct.proxyUrl = newProxy;
    acct.proxyFailed = false;
    acct.proxyEpoch = epoch;
    // Persist asynchronously — not on hot path
    queueMicrotask(() => {
      try {
        saveAccountsToFile(accounts);
      } catch {
        /* best-effort */
      }
    });
  }
  return newProxy ?? undefined;
}

/**
 * Mark an account's current proxy as failed.
 * Bumps the epoch so the next getAccountProxy() rebinds to a NEW session
 * (different suffix → different exit IP), breaking the failure loop.
 */
export function markProxyFailed(email: string): void {
  const acct = getAccountByEmail(email);
  if (!acct) return;
  acct.proxyFailed = true;
  acct.proxyUrl = undefined;
  acct.proxyEpoch = (acct.proxyEpoch ?? 0) + 1;
  logStore.log('warn', 'proxy', `Proxy marked FAILED for ${sanitizeEmail(email)} — epoch=${acct.proxyEpoch}, will rebind to a new IP`);
}

/**
 * Clear an account's proxy-failed state without rebinding.
 * Used after a successful probe cycle.
 */
export function clearProxyFailed(email: string): void {
  const acct = getAccountByEmail(email);
  if (!acct) return;
  acct.proxyFailed = false;
}

// ─── Probe logic ────────────────────────────────────────────────────────────

interface ProbeResult {
  ok: boolean;
  ip: string;
  acwTc: boolean;
  error?: string;
}

/**
 * Test a single proxy URL for basic connectivity + qwen.ai WAF status.
 * Returns structured result for diagnostics.
 */
export async function probeProxy(proxyUrl: string): Promise<ProbeResult> {
  const result: ProbeResult = { ok: false, ip: '', acwTc: false };

  try {
    const ipInit: RequestInit = {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    };
    (ipInit as any).proxy = proxyUrl;
    const ipResp = await fetch('https://ipinfo.io/json', ipInit);
    if (!ipResp.ok) {
      result.error = `IP check returned ${ipResp.status}`;
      return result;
    }
    const ipData = (await ipResp.json()) as { ip?: string };
    result.ip = ipData.ip ?? 'unknown';

    // Step 2: chat.qwen.ai root → acw_tc cookie
    const qwenInit: RequestInit = {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      headers: { accept: 'text/html,application/xhtml+xml' },
    };
    (qwenInit as any).proxy = proxyUrl;
    const qwenResp = await fetch('https://chat.qwen.ai', qwenInit);
    const setCookie = qwenResp.headers.get('set-cookie') ?? '';
    result.acwTc = setCookie.includes('acw_tc=');

    result.ok = qwenResp.ok && result.acwTc;
    if (!qwenResp.ok) {
      result.error = `qwen.ai root returned ${qwenResp.status}`;
    } else if (!result.acwTc) {
      result.error = 'no acw_tc in qwen.ai response';
    }

    logStore.log(
      result.ok ? 'info' : 'warn',
      'proxy',
      `Probe ${proxyUrl.split('@')[0]}@... → IP=${result.ip} acw_tc=${result.acwTc} ok=${result.ok}${result.error ? ' err=' + result.error : ''}`,
    );
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    result.error = msg;
    logStore.log('warn', 'proxy', `Probe failed for ${proxyUrl.split('@')[0]}@...: ${msg}`);
  }

  return result;
}

/**
 * Probe all accounts' proxies at startup.
 * Runs probes concurrently (throttled to PROBE_CONCURRENCY).
 * Accounts whose probes fail get markProxyFailed() so they rebind on first use.
 */
export async function probeAllAccounts(accountEmails: readonly string[]): Promise<void> {
  const results: Array<{ email: string; result: ProbeResult }> = [];

  // Throttled parallel probe
  const chunks: string[][] = [];
  for (let i = 0; i < accountEmails.length; i += PROBE_CONCURRENCY) {
    chunks.push(accountEmails.slice(i, i + PROBE_CONCURRENCY));
  }

  for (const chunk of chunks) {
    const probes = chunk.map(async (email) => {
      const proxy = getAccountProxy(email);
      if (!proxy) return { email, result: { ok: false, ip: '', acwTc: false, error: 'no proxy configured' } };
      const result = await probeProxy(proxy);
      return { email, result };
    });
    const chunkResults = await Promise.all(probes);
    results.push(...chunkResults);
  }

  // Process results
  for (const { email, result } of results) {
    if (!result.ok) {
      markProxyFailed(email);
      logStore.log('warn', 'proxy', `Account ${sanitizeEmail(email)}: proxy probe FAILED, will rebind on next use`);
    }
  }

  const okCount = results.filter((r) => r.result.ok).length;
  logStore.log('info', 'proxy', `Proxy probe: ${okCount}/${results.length} accounts OK`);
}
