// SERVER-ONLY: isolated visual browser for OpenAI's built-in `computer` tool.
// It is PUBLIC-INTERNET-ONLY. Cookies and origin storage persist server-side so
// the operator can keep signed-in public sessions, while private lab work stays
// on lab_request/run_shell and their approval pipeline. This harness must never
// become a tunnel into the LAN.

import 'server-only';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { promises as dns } from 'node:dns';
import type { Browser, BrowserContext, Page } from 'playwright-core';
import { chromium } from 'playwright-core';
import { writeFileAtomic } from '@/lib/atomic-write';
import type { BrowserTabDto, BrowserViewportDto } from '@/lib/assistant/types';

const WIDTH = 1280;
const HEIGHT = 720;
const MAX_ACTIONS_PER_CALL = 50;
const PUBLIC_DNS_TIMEOUT_MS = 4_000;
const STATE_FILE = path.join(process.cwd(), 'data', 'assistant-browser-state.json');

export type ComputerAction = Record<string, unknown> & { type?: string };
export interface BrowserFrame {
  imageUrl: string;
  url: string;
  title: string;
  tabId: string;
  tabs: BrowserTabDto[];
  viewport: BrowserViewportDto;
}
type SavedStorageState = Awaited<ReturnType<BrowserContext['storageState']>>;

export interface BrowserTarget {
  tabId?: string;
  viewport?: BrowserViewportDto;
}

const START_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>Public browser</title><style>
html,body{height:100%;margin:0}body{display:grid;place-items:center;background:#f5f7fa;color:#17202a;font:16px system-ui,sans-serif}
main{width:min(680px,calc(100% - 64px))}h1{font-size:30px;margin:0 0 10px}p{color:#53606d;margin:0 0 24px}
form{display:flex;gap:10px}input{flex:1;font:inherit;padding:13px 15px;border:1px solid #a9b4bf;border-radius:8px;background:white}
button{font:600 15px system-ui;padding:0 20px;border:0;border-radius:8px;background:#1668dc;color:white}
</style></head><body><main><h1>Public browser</h1><p>Search or open a public site. Signed-in sessions stay in this server-side browser; private networks remain blocked.</p>
<form action="https://www.google.com/search" method="get"><input name="q" aria-label="Search the web" autofocus><button type="submit">Search</button></form>
</main></body></html>`;

function privateIpv4(address: string): boolean {
  const p = address.split('.').map(Number);
  if (p.length !== 4 || p.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = p;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19))
  );
}

function privateIp(address: string): boolean {
  const value = address.toLowerCase().split('%')[0];
  if (net.isIPv4(value)) return privateIpv4(value);
  if (!net.isIPv6(value)) return true;
  if (value.startsWith('::ffff:')) return privateIpv4(value.slice('::ffff:'.length));
  return (
    value === '::' ||
    value === '::1' ||
    value.startsWith('fc') ||
    value.startsWith('fd') ||
    /^fe[89ab]/.test(value) ||
    value.startsWith('ff')
  );
}

function privateHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.lan') ||
    host.endsWith('.internal') ||
    host.endsWith('.home.arpa')
  );
}

function chromiumExecutable(): string | undefined {
  const configured =
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ?? process.env.CHROMIUM_EXECUTABLE_PATH;
  const candidates = [
    configured,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    process.env.LOCALAPPDATA
      ? `${process.env.LOCALAPPDATA}\\Microsoft\\Edge\\Application\\msedge.exe`
      : undefined,
  ];
  return candidates.find((candidate): candidate is string => !!candidate && fs.existsSync(candidate));
}

function numberField(action: ComputerAction, name: string, fallback?: number): number {
  const value = action[name];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (fallback !== undefined) return fallback;
  throw new Error(`computer action ${action.type ?? 'unknown'} needs numeric ${name}`);
}

function normalizeKey(key: string): string {
  const map: Record<string, string> = {
    ENTER: 'Enter', RETURN: 'Enter', ESC: 'Escape', ESCAPE: 'Escape', TAB: 'Tab',
    SPACE: 'Space', BACKSPACE: 'Backspace', DELETE: 'Delete', DEL: 'Delete',
    HOME: 'Home', END: 'End', PAGEUP: 'PageUp', PAGEDOWN: 'PageDown',
    UP: 'ArrowUp', ARROWUP: 'ArrowUp', DOWN: 'ArrowDown', ARROWDOWN: 'ArrowDown',
    LEFT: 'ArrowLeft', ARROWLEFT: 'ArrowLeft', RIGHT: 'ArrowRight', ARROWRIGHT: 'ArrowRight',
    CTRL: 'Control', CONTROL: 'Control', SHIFT: 'Shift', OPTION: 'Alt', ALT: 'Alt',
    META: 'Meta', CMD: 'Meta', COMMAND: 'Meta',
  };
  return map[key.toUpperCase()] ?? key;
}

function mouseButton(value: unknown): 'left' | 'right' | 'middle' {
  if (value === undefined || value === 'left') return 'left';
  if (value === 'right') return 'right';
  if (value === 'wheel' || value === 'middle') return 'middle';
  throw new Error(`unsupported computer mouse button: ${String(value)}`);
}

async function withModifiers(page: Page, value: unknown, action: () => Promise<void>): Promise<void> {
  const keys = Array.isArray(value)
    ? value.filter((key): key is string => typeof key === 'string').map(normalizeKey)
    : [];
  const pressed: string[] = [];
  try {
    for (const key of keys) {
      await page.keyboard.down(key);
      pressed.push(key);
    }
    await action();
  } finally {
    for (const key of pressed.reverse()) await page.keyboard.up(key);
  }
}

function dragPoints(value: unknown): { x: number; y: number }[] {
  if (!Array.isArray(value)) throw new Error('computer drag action needs a path');
  return value.map((point) => {
    if (Array.isArray(point) && point.length >= 2) {
      return { x: Number(point[0]), y: Number(point[1]) };
    }
    if (point && typeof point === 'object') {
      const p = point as Record<string, unknown>;
      return { x: Number(p.x), y: Number(p.y) };
    }
    throw new Error('invalid computer drag point');
  }).filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
}

function safeViewport(value?: BrowserViewportDto): BrowserViewportDto {
  if (!value) return { width: WIDTH, height: HEIGHT };
  const width = Math.round(Number(value.width));
  const height = Math.round(Number(value.height));
  return {
    width: Number.isFinite(width) ? Math.min(Math.max(width, 480), 1_600) : WIDTH,
    height: Number.isFinite(height) ? Math.min(Math.max(height, 320), 1_000) : HEIGHT,
  };
}

export class PublicBrowserComputer {
  private browser?: Browser;
  private context?: BrowserContext;
  private readonly pages = new Map<string, Page>();
  private readonly pageIds = new WeakMap<Page, string>();
  private activeTabId?: string;
  private persistTimer?: ReturnType<typeof setTimeout>;
  private readonly hostChecks = new Map<string, Promise<boolean>>();
  private queue: Promise<unknown> = Promise.resolve();

  private serialized<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  private registerPage(page: Page, activate = true): string {
    const known = this.pageIds.get(page);
    if (known) {
      if (activate) this.activeTabId = known;
      return known;
    }
    const id = randomUUID();
    this.pageIds.set(page, id);
    this.pages.set(id, page);
    if (activate || !this.activeTabId) this.activeTabId = id;
    page.on('dialog', (dialog) => void dialog.dismiss());
    page.on('download', (download) => void download.cancel());
    page.on('close', () => {
      this.pages.delete(id);
      if (this.activeTabId === id) this.activeTabId = this.pages.keys().next().value;
    });
    return id;
  }

  private activePage(tabId?: string): { id: string; page: Page } {
    const requested = tabId && this.pages.get(tabId);
    if (requested && !requested.isClosed()) {
      this.activeTabId = tabId;
      return { id: tabId, page: requested };
    }
    const active = this.activeTabId && this.pages.get(this.activeTabId);
    if (active && !active.isClosed()) return { id: this.activeTabId!, page: active };
    for (const [id, page] of this.pages) {
      if (!page.isClosed()) {
        this.activeTabId = id;
        return { id, page };
      }
    }
    throw new Error('Browser has no open tab.');
  }

  private savedState(): SavedStorageState | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as SavedStorageState;
      return parsed && Array.isArray(parsed.cookies) && Array.isArray(parsed.origins)
        ? parsed
        : undefined;
    } catch {
      return undefined;
    }
  }

  private async persistState(): Promise<void> {
    if (!this.context) return;
    const state = await this.context.storageState();
    writeFileAtomic(STATE_FILE, JSON.stringify(state));
  }

  private schedulePersist(): void {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persistState().catch(() => undefined);
    }, 750);
  }

  private async publicHost(hostname: string): Promise<boolean> {
    if (privateHostname(hostname)) return false;
    if (net.isIP(hostname)) return !privateIp(hostname);
    const cached = this.hostChecks.get(hostname);
    if (cached) return cached;
    const check = Promise.race([
      dns.lookup(hostname, { all: true }).then(
        (addresses) => addresses.length > 0 && addresses.every((a) => !privateIp(a.address)),
        () => false,
      ),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), PUBLIC_DNS_TIMEOUT_MS)),
    ]);
    this.hostChecks.set(hostname, check);
    return check;
  }

  private async ensurePage(): Promise<Page> {
    try {
      return this.activePage().page;
    } catch {
      /* first launch or every tab was closed */
    }
    if (this.context) {
      const page = await this.context.newPage();
      this.registerPage(page);
      await page.setContent(START_PAGE, { waitUntil: 'domcontentloaded' });
      return page;
    }
    const executablePath = chromiumExecutable();
    if (!executablePath) {
      throw new Error(
        'Visual browser is unavailable: Chromium was not found. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH.',
      );
    }
    this.browser = await chromium.launch({
      executablePath,
      headless: true,
      // The production app already runs as an unprivileged user inside its own
      // container. Debian's system Chromium has no usable setuid/user-namespace
      // sandbox in that environment; forcing it on makes Chromium exit before
      // a page is created. Let Playwright apply its container launch mode.
      chromiumSandbox: false,
      env: {},
      args: ['--disable-extensions', '--disable-file-system', '--disable-dev-shm-usage'],
    });
    this.browser.on('disconnected', () => {
      this.browser = undefined;
      this.context = undefined;
      this.pages.clear();
      this.activeTabId = undefined;
    });
    this.context = await this.browser.newContext({
      viewport: { width: WIDTH, height: HEIGHT },
      acceptDownloads: false,
      storageState: this.savedState(),
    });
    await this.context.route('**/*', async (route) => {
      const request = route.request();
      let url: URL;
      try {
        url = new URL(request.url());
      } catch {
        await route.abort('blockedbyclient');
        return;
      }
      if (!['http:', 'https:'].includes(url.protocol)) {
        await route.continue();
        return;
      }
      if (!(await this.publicHost(url.hostname))) {
        await route.abort('blockedbyclient');
        return;
      }
      await route.continue();
    });
    this.context.on('page', (page) => this.registerPage(page));
    const page = await this.context.newPage();
    this.registerPage(page);
    await page.setContent(START_PAGE, { waitUntil: 'domcontentloaded' });
    return page;
  }

  private async frame(page: Page): Promise<BrowserFrame> {
    const tabId = this.registerPage(page, false);
    const [screenshot, title, tabs] = await Promise.all([
      page.screenshot({ type: 'jpeg', quality: 78, animations: 'disabled' }),
      page.title().catch(() => ''),
      Promise.all([...this.pages.entries()].map(async ([id, tab]) => ({
        id,
        title: await tab.title().catch(() => '') || 'New tab',
        url: tab.url(),
      }))),
    ]);
    return {
      imageUrl: `data:image/jpeg;base64,${screenshot.toString('base64')}`,
      url: page.url(),
      title,
      tabId,
      tabs,
      viewport: page.viewportSize() ?? { width: WIDTH, height: HEIGHT },
    };
  }

  private async applyViewport(page: Page, viewport?: BrowserViewportDto): Promise<void> {
    if (!viewport) return;
    const next = safeViewport(viewport);
    const current = page.viewportSize();
    if (!current || current.width !== next.width || current.height !== next.height) {
      await page.setViewportSize(next);
    }
  }

  private async settle(page: Page, maxMs = 100): Promise<void> {
    await Promise.race([
      page.evaluate(() => new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      )).catch(() => undefined),
      page.waitForTimeout(maxMs),
    ]);
  }

  private async openUrl(page: Page, rawUrl: string): Promise<void> {
    const normalized = /^https?:\/\//i.test(rawUrl.trim()) ? rawUrl.trim() : `https://${rawUrl.trim()}`;
    let url: URL;
    try {
      url = new URL(normalized);
    } catch {
      throw new Error('Enter a valid http(s) URL.');
    }
    if (!['http:', 'https:'].includes(url.protocol) || !(await this.publicHost(url.hostname))) {
      throw new Error('That address is not a public http(s) destination.');
    }
    // Return the first committed render quickly. The client asks for a follow-up
    // snapshot while the page finishes loading instead of freezing the browser
    // controls behind a full DOM/network wait.
    await page.goto(url.toString(), { waitUntil: 'commit', timeout: 20_000 });
    await Promise.race([
      page.waitForLoadState('domcontentloaded').catch(() => undefined),
      page.waitForTimeout(600),
    ]);
  }

  private async runNow(
    actions: ComputerAction[],
    signal?: AbortSignal,
    target: BrowserTarget = {},
  ): Promise<BrowserFrame> {
    if (!Array.isArray(actions) || actions.length > MAX_ACTIONS_PER_CALL) {
      throw new Error(`computer call exceeds the ${MAX_ACTIONS_PER_CALL}-action safety limit`);
    }
    await this.ensurePage();
    const { page } = this.activePage(target.tabId);
    await this.applyViewport(page, target.viewport);
    for (const action of actions) {
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      switch (action.type) {
        case 'click':
          await withModifiers(page, action.keys, () =>
            page.mouse.click(numberField(action, 'x'), numberField(action, 'y'), {
              button: mouseButton(action.button),
            }),
          );
          break;
        case 'double_click':
          await withModifiers(page, action.keys, () =>
            page.mouse.dblclick(numberField(action, 'x'), numberField(action, 'y'), {
              button: mouseButton(action.button),
            }),
          );
          break;
        case 'move':
          await withModifiers(page, action.keys, () =>
            page.mouse.move(numberField(action, 'x'), numberField(action, 'y')),
          );
          break;
        case 'scroll':
          await withModifiers(page, action.keys, async () => {
            const viewport = page.viewportSize() ?? { width: WIDTH, height: HEIGHT };
            await page.mouse.move(numberField(action, 'x', viewport.width / 2), numberField(action, 'y', viewport.height / 2));
            await page.mouse.wheel(numberField(action, 'scroll_x', 0), numberField(action, 'scroll_y', 0));
          });
          break;
        case 'drag': {
          const points = dragPoints(action.path);
          if (points.length < 2) throw new Error('computer drag action needs two valid points');
          await withModifiers(page, action.keys, async () => {
            await page.mouse.move(points[0].x, points[0].y);
            await page.mouse.down();
            for (const point of points.slice(1)) await page.mouse.move(point.x, point.y, { steps: 4 });
            await page.mouse.up();
          });
          break;
        }
        case 'keypress': {
          const keys = Array.isArray(action.keys)
            ? action.keys.filter((key): key is string => typeof key === 'string').map(normalizeKey)
            : [];
          if (keys.length === 0) throw new Error('computer keypress action needs keys');
          const modifiers = new Set(['Control', 'Shift', 'Alt', 'Meta']);
          if (keys.length > 1 && keys.slice(0, -1).every((key) => modifiers.has(key))) {
            await page.keyboard.press(keys.join('+'));
          } else {
            for (const key of keys) await page.keyboard.press(key);
          }
          break;
        }
        case 'type':
          if (typeof action.text !== 'string') throw new Error('computer type action needs text');
          await page.keyboard.type(action.text);
          break;
        case 'wait':
          await page.waitForTimeout(2_000);
          break;
        case 'screenshot':
          break;
        default:
          throw new Error(`unsupported computer action: ${String(action.type)}`);
      }
    }
    await this.settle(page);
    this.schedulePersist();
    return this.frame(this.activePage().page);
  }

  run(actions: ComputerAction[], signal?: AbortSignal, target: BrowserTarget = {}): Promise<BrowserFrame> {
    return this.serialized(() => this.runNow(actions, signal, target));
  }

  snapshot(target: BrowserTarget = {}): Promise<BrowserFrame> {
    return this.serialized(async () => {
      await this.ensurePage();
      const { page } = this.activePage(target.tabId);
      await this.applyViewport(page, target.viewport);
      return this.frame(page);
    });
  }

  navigate(rawUrl: string, target: BrowserTarget = {}): Promise<BrowserFrame> {
    return this.serialized(async () => {
      await this.ensurePage();
      const { page } = this.activePage(target.tabId);
      await this.applyViewport(page, target.viewport);
      await this.openUrl(page, rawUrl);
      this.schedulePersist();
      return this.frame(page);
    });
  }

  newTab(rawUrl?: string, target: BrowserTarget = {}): Promise<BrowserFrame> {
    return this.serialized(async () => {
      await this.ensurePage();
      const page = await this.context!.newPage();
      this.registerPage(page);
      await this.applyViewport(page, target.viewport);
      if (rawUrl?.trim()) await this.openUrl(page, rawUrl);
      else await page.setContent(START_PAGE, { waitUntil: 'domcontentloaded' });
      return this.frame(page);
    });
  }

  activateTab(tabId: string, viewport?: BrowserViewportDto): Promise<BrowserFrame> {
    return this.serialized(async () => {
      await this.ensurePage();
      const { page } = this.activePage(tabId);
      await this.applyViewport(page, viewport);
      return this.frame(page);
    });
  }

  closeTab(tabId: string, viewport?: BrowserViewportDto): Promise<BrowserFrame> {
    return this.serialized(async () => {
      await this.ensurePage();
      const page = this.pages.get(tabId);
      if (page) await page.close().catch(() => undefined);
      const active = await this.ensurePage();
      await this.applyViewport(active, viewport);
      return this.frame(active);
    });
  }

  history(direction: 'back' | 'forward' | 'reload', target: BrowserTarget = {}): Promise<BrowserFrame> {
    return this.serialized(async () => {
      await this.ensurePage();
      const { page } = this.activePage(target.tabId);
      await this.applyViewport(page, target.viewport);
      if (direction === 'back') await page.goBack({ waitUntil: 'commit', timeout: 10_000 }).catch(() => null);
      else if (direction === 'forward') await page.goForward({ waitUntil: 'commit', timeout: 10_000 }).catch(() => null);
      else await page.reload({ waitUntil: 'commit', timeout: 15_000 }).catch(() => null);
      await this.settle(page, 150);
      this.schedulePersist();
      return this.frame(page);
    });
  }

  async close(): Promise<void> {
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = undefined;
    await this.persistState().catch(() => undefined);
    this.pages.clear();
    this.activeTabId = undefined;
    this.context = undefined;
    const browser = this.browser;
    this.browser = undefined;
    if (browser) await browser.close().catch(() => undefined);
  }
}

const browserGlobal = globalThis as typeof globalThis & {
  __grtlabsPublicBrowser?: PublicBrowserComputer;
};

/** One browser/session for the single signed-in operator. Routes and the model
 * share this instance; cookies are persisted separately so a process restart
 * can reopen the same logged-in session without exposing cookie values. */
export function getPublicBrowserComputer(): PublicBrowserComputer {
  return (browserGlobal.__grtlabsPublicBrowser ??= new PublicBrowserComputer());
}
