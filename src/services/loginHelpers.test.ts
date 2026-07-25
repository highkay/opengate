/**
 * Unit tests for login helper classification (WAF / empty body / no blind CAPTCHA label).
 */
import { describe, expect, test } from 'bun:test';
import { isWafResponseBody } from './loginHelpers.ts';

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
