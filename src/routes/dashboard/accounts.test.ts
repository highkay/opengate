import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { accountsHtml } from './accounts.ts';

const accountsScript = readFileSync(new URL('./public/accounts.js', import.meta.url), 'utf-8');

describe('accounts dashboard login jobs', () => {
  test('renders a dedicated login task notice area', () => {
    expect(accountsHtml).toContain('id="loginJobBox"');
  });

  test('starts async login tasks and polls their status', () => {
    expect(accountsScript).toContain("method: 'POST'");
    expect(accountsScript).toContain("'/login'");
    expect(accountsScript).toContain("'/login-jobs/'");
    expect(accountsScript).not.toContain("'/autofill'");
  });

  test('surfaces classified failures and manual login guidance', () => {
    expect(accountsScript).toContain('job.failure.code');
    expect(accountsScript).toContain('job.apiFailure.code');
    expect(accountsScript).toContain('job.manualUrl');
  });
});
