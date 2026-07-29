/**
 * Unit tests for login helper classification (WAF / empty body / no blind CAPTCHA label).
 */
import { afterEach, describe, expect, test } from 'bun:test';
import {
  extractTokensFromSetCookie,
  findAuthCookieValues,
  getLastLoginFailure,
  isWafResponseBody,
  loginFreshViaFetch,
} from './loginHelpers.ts';

const originalFetch = globalThis.fetch;
const originalMockPlaywright = process.env.TEST_MOCK_PLAYWRIGHT;

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalMockPlaywright === undefined) delete process.env.TEST_MOCK_PLAYWRIGHT;
  else process.env.TEST_MOCK_PLAYWRIGHT = originalMockPlaywright;
});

describe('isWafResponseBody', () => {
  test('detects text/html content-type', () => {
    expect(isWafResponseBody('{"ok":true}', 'text/html; charset=utf-8')).toBe(true);
  });

  test('detects aliyun_waf markers in body', () => {
    const html = '<!doctypehtml><meta charset="UTF-8"><meta name="aliyun_waf_aa" content="abc"><title>x</title>';
    expect(isWafResponseBody(html, 'application/json')).toBe(true);
  });

  test('detects bare HTML doctype without content-type', () => {
    expect(isWafResponseBody('<!DOCTYPE html><html></html>', null)).toBe(true);
  });

  test('allows normal JSON', () => {
    expect(isWafResponseBody(JSON.stringify({ success: true, data: { token: 'abc' } }), 'application/json')).toBe(false);
  });

  test('empty body is not WAF by itself', () => {
    expect(isWafResponseBody('', 'application/json')).toBe(false);
  });
});

describe('login cookie classification', () => {
  test('does not treat WAF token-like cookies as auth tokens', () => {
    expect(
      findAuthCookieValues([
        { name: 'bx-umidtoken', value: 'waf-value' },
        { name: 'csrf_token', value: 'csrf-value' },
        { name: 'refresh_token', value: 'refresh-value' },
      ]),
    ).toEqual({ token: null, refreshToken: 'refresh-value' });
  });

  test('extracts only exact auth cookie names from set-cookie', () => {
    const headers = new Headers();
    headers.append('set-cookie', 'bx-umidtoken=waf-value; Path=/');
    headers.append('set-cookie', 'token=auth-value; Path=/; HttpOnly');
    headers.append('set-cookie', 'refresh_token=refresh-value; Path=/; HttpOnly');

    expect(extractTokensFromSetCookie(new Response('', { headers }))).toEqual({
      token: 'auth-value',
      refreshToken: 'refresh-value',
    });
  });
});

describe('login retries and failure scope', () => {
  test('does not retry credential failures', async () => {
    process.env.TEST_MOCK_PLAYWRIGHT = '1';
    let calls = 0;
    globalThis.fetch = (async () => {
      calls++;
      return new Response(JSON.stringify({ success: false, message: 'invalid password' }), {
        status: 401,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    expect(await loginFreshViaFetch('credentials@example.com', 'hash', { baseDelayMs: 0, random: () => 0 })).toBeNull();
    expect(calls).toBe(1);
    expect(getLastLoginFailure()).toMatchObject({ code: 'credentials', retryable: false });
  });

  test('keeps concurrent failure classifications bound to each login caller', async () => {
    process.env.TEST_MOCK_PLAYWRIGHT = '1';
    globalThis.fetch = (async (_url: URL | RequestInfo, init?: RequestInit) => {
      const email = JSON.parse(String(init?.body)).email as string;
      await new Promise((resolve) => setTimeout(resolve, email.startsWith('slow') ? 20 : 1));
      const message = email.startsWith('slow') ? 'account is not registered' : 'invalid password';
      return new Response(JSON.stringify({ success: false, message }), {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    }) as unknown as typeof fetch;

    const runLogin = async (email: string) => {
      await loginFreshViaFetch(email, 'hash', { baseDelayMs: 0, random: () => 0 });
      return getLastLoginFailure();
    };

    const [slowFailure, fastFailure] = await Promise.all([runLogin('slow@example.com'), runLogin('fast@example.com')]);
    expect(slowFailure?.code).toBe('not_registered');
    expect(fastFailure?.code).toBe('credentials');
  });
});
