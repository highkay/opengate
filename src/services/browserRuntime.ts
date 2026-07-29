import { accessSync, constants } from 'node:fs';
import type { BrowserContextOptions, LaunchOptions } from 'playwright';
import type { BrowserContext } from 'playwright-core';

export const DEFAULT_BROWSER_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

export const BROWSER_DEFAULT_ARGS: readonly string[] = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-gpu',
  '--ozone-platform-hint=auto',
];

const EXECUTABLE_ENV_KEYS = [
  'BROWSER_EXECUTABLE_PATH',
  'CHROMIUM_EXECUTABLE_PATH',
  'PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH',
  'CLOAKBROWSER_BINARY_PATH',
] as const;

const SYSTEM_CHROMIUM_CANDIDATES = [
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/google-chrome',
  '/opt/google/chrome/chrome',
] as const;

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveBrowserExecutablePath(
  env: NodeJS.ProcessEnv = process.env,
  candidates: readonly string[] = SYSTEM_CHROMIUM_CANDIDATES,
): string | undefined {
  for (const key of EXECUTABLE_ENV_KEYS) {
    const configuredPath = env[key]?.trim();
    if (configuredPath && isExecutable(configuredPath)) return configuredPath;
  }
  return candidates.find(isExecutable);
}

export function configureBrowserRuntime(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const executablePath = resolveBrowserExecutablePath(env);
  if (!executablePath) return undefined;

  env.BROWSER_EXECUTABLE_PATH = executablePath;
  env.CLOAKBROWSER_BINARY_PATH = executablePath;
  env.PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD = '1';
  return executablePath;
}

export interface HeadedBrowserAvailability {
  available: boolean;
  reason?: string;
}

export function getHeadedBrowserAvailability(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): HeadedBrowserAvailability {
  if (platform !== 'linux') return { available: true };
  if (env.DISPLAY?.trim() || env.WAYLAND_DISPLAY?.trim()) return { available: true };
  return {
    available: false,
    reason: 'headed browser requires DISPLAY or WAYLAND_DISPLAY; enable the manual browser console or provide an X server',
  };
}

function mergeArgs(extraArgs: readonly string[] = []): string[] {
  return [...new Set([...BROWSER_DEFAULT_ARGS, ...extraArgs])];
}

export function getChromiumLaunchOptions(headless = true, extraArgs: readonly string[] = []): LaunchOptions {
  const executablePath = configureBrowserRuntime();
  return {
    headless,
    ...(executablePath ? { executablePath } : {}),
    args: mergeArgs(extraArgs),
  };
}

export function getBrowserContextOptions(): BrowserContextOptions {
  return { userAgent: DEFAULT_BROWSER_USER_AGENT };
}

export async function prepareCaptchaHandoff(context: Pick<BrowserContext, 'close'>, headless: boolean): Promise<'closed' | 'keep_open'> {
  if (!headless) return 'keep_open';
  await context.close();
  return 'closed';
}

export interface PersistentBrowserLaunchOptions {
  userDataDir: string;
  headless: boolean;
  humanize?: boolean;
  geoip?: boolean;
  viewport?: { width: number; height: number } | null;
  args?: readonly string[];
}

export async function launchPersistentBrowserContext(options: PersistentBrowserLaunchOptions): Promise<BrowserContext> {
  const executablePath = configureBrowserRuntime();
  const { launchPersistentContext } = await import('cloakbrowser');
  return launchPersistentContext({
    ...options,
    userAgent: DEFAULT_BROWSER_USER_AGENT,
    args: mergeArgs(options.args),
    launchOptions: executablePath ? { executablePath } : undefined,
  });
}

export function parseCookieHeader(cookieHeader: string): Map<string, string> {
  const cookies = new Map<string, string>();
  for (const pair of cookieHeader.split(';')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    const name = pair.slice(0, separator).trim();
    if (!name) continue;
    cookies.set(name, pair.slice(separator + 1).trim());
  }
  return cookies;
}

export function mergeCookieHeaders(...cookieHeaders: Array<string | null | undefined>): string {
  const merged = new Map<string, string>();
  for (const cookieHeader of cookieHeaders) {
    if (!cookieHeader) continue;
    for (const [name, value] of parseCookieHeader(cookieHeader)) merged.set(name, value);
  }
  return Array.from(merged, ([name, value]) => `${name}=${value}`).join('; ');
}

export function getCookieNames(cookieHeader: string): string[] {
  return Array.from(parseCookieHeader(cookieHeader).keys());
}

configureBrowserRuntime();
