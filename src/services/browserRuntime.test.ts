import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  configureBrowserRuntime,
  DEFAULT_BROWSER_USER_AGENT,
  getBrowserContextOptions,
  getHeadedBrowserAvailability,
  mergeCookieHeaders,
  parseCookieHeader,
  prepareCaptchaHandoff,
  resolveBrowserExecutablePath,
} from './browserRuntime.ts';

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function createExecutable(): string {
  const dir = mkdtempSync(join(tmpdir(), 'opengate-browser-'));
  tempDirs.push(dir);
  const executable = join(dir, 'chromium');
  writeFileSync(executable, '#!/bin/sh\nexit 0\n');
  chmodSync(executable, 0o755);
  return executable;
}

describe('browser runtime', () => {
  test('uses one executable path for Playwright and CloakBrowser', () => {
    const executable = createExecutable();
    const env: NodeJS.ProcessEnv = { BROWSER_EXECUTABLE_PATH: executable };

    expect(resolveBrowserExecutablePath(env, [])).toBe(executable);
    expect(configureBrowserRuntime(env)).toBe(executable);
    expect(env.CLOAKBROWSER_BINARY_PATH).toBe(executable);
    expect(env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD).toBe('1');
  });

  test('configures user agent at context creation instead of Page.setUserAgent', () => {
    expect(getBrowserContextOptions()).toEqual({ userAgent: DEFAULT_BROWSER_USER_AGENT });
  });

  test('classifies headed Linux browser without a display as unavailable', () => {
    expect(getHeadedBrowserAvailability({}, 'linux')).toEqual({
      available: false,
      reason: expect.stringContaining('DISPLAY'),
    });
    expect(getHeadedBrowserAvailability({ DISPLAY: ':99' }, 'linux')).toEqual({ available: true });
  });

  test('closes headless CAPTCHA context before headed handoff', async () => {
    let closed = false;
    const context = { close: async () => void (closed = true) };

    expect(await prepareCaptchaHandoff(context, true)).toBe('closed');
    expect(closed).toBe(true);
  });

  test('keeps headed CAPTCHA context open for manual completion', async () => {
    let closed = false;
    const context = { close: async () => void (closed = true) };

    expect(await prepareCaptchaHandoff(context, false)).toBe('keep_open');
    expect(closed).toBe(false);
  });
});

describe('cookie merging', () => {
  test('merges by exact name while preserving auth and all WAF cookies', () => {
    const merged = mergeCookieHeaders(
      'token=auth-token; refresh_token=refresh-token; cna=old-cna; tfstk=tfstk-value; isg=isg-value',
      'cna=new-cna; acw_tc=acw-value; ssxmod_itna=itna-value',
    );

    expect(parseCookieHeader(merged)).toEqual(
      new Map([
        ['token', 'auth-token'],
        ['refresh_token', 'refresh-token'],
        ['cna', 'new-cna'],
        ['tfstk', 'tfstk-value'],
        ['isg', 'isg-value'],
        ['acw_tc', 'acw-value'],
        ['ssxmod_itna', 'itna-value'],
      ]),
    );
  });
});
