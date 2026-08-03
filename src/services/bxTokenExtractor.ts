/**
 * Extract bx-umidtoken from Alibaba's WUM endpoint.
 *
 * bx-umidtoken is a long-lived device ID token (hours-days TTL).
 * It's returned by sg-wum.alibaba.com as a JS callback wrapping a base64 token.
 *
 * Uses native fetch (verified 2026-08-04: returns 200 + token directly).
 * The endpoint returns: umx.wu('BASE64_TOKEN') or __fycb('BASE64_TOKEN')
 */

const WUM_URL = 'https://sg-wum.alibaba.com/w/wu.json';

/**
 * Extract bx-umidtoken from the sg-wum.alibaba.com endpoint.
 * Cached via tokenCache with 4h TTL — callers should not cache on top of this.
 */
export async function extractBxUmidtoken(proxy?: string): Promise<string> {
  const headers: Record<string, string> = {
    accept: '*/*',
    'accept-language': 'en-US,en;q=0.9',
    'cache-control': 'no-cache',
    pragma: 'no-cache',
  };
  const fetchInit: RequestInit = { method: 'GET', headers };
  // Bun native fetch supports http(s) proxies only; socks5 falls back to direct.
  if (proxy && /^https?:\/\//i.test(proxy)) (fetchInit as any).proxy = proxy;

  const response = await globalThis.fetch(WUM_URL, fetchInit);

  if (!response.ok) {
    throw new Error(`bx-umidtoken extraction failed: ${response.status} ${response.statusText}`);
  }

  const text = await response.text();

  // Match: umx.wu('BASE64_TOKEN') or __fycb('BASE64_TOKEN')
  const match = text.match(/(?:umx\.wu|__fycb)\('([^']+)'\)/);
  if (!match) {
    throw new Error(`bx-umidtoken extraction failed: unexpected response format: ${text.slice(0, 100)}`);
  }

  return match[1];
}
