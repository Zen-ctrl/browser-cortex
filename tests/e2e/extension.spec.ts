import { expect, test, chromium, type BrowserContext, type Page, type ServiceWorker } from '@playwright/test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';

import { prepareExtensionFixture } from './extension-fixture';

interface BrokerResponse {
  ok: boolean;
  requestId: string;
  data?: Record<string, unknown>;
  error?: { code: string; message: string };
}

async function send(
  page: Page,
  type: string,
  payload: Record<string, unknown> = {},
  sessionId?: string,
): Promise<BrokerResponse> {
  return await page.evaluate(async ({ messageType, messagePayload, activeSession }) => {
    return await chrome.runtime.sendMessage({
      schemaVersion: 1,
      requestId: crypto.randomUUID(),
      type: messageType,
      payload: messagePayload,
      ...(activeSession ? { sessionId: activeSession } : {}),
    }) as BrokerResponse;
  }, { messageType: type, messagePayload: payload, activeSession: sessionId });
}

async function extensionWorker(context: BrowserContext): Promise<ServiceWorker> {
  const current = context.serviceWorkers()[0];
  return current ?? await context.waitForEvent('serviceworker');
}

test('production extension enforces capture, message, recording, and vault boundaries', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'browser-cortex-e2e-'));
  let context: BrowserContext | undefined;
  try {
    const extensionPath = await prepareExtensionFixture(profile);
    context = await chromium.launchPersistentContext(profile, {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });
    const worker = await extensionWorker(context);
    const extensionId = new URL(worker.url()).host;
    expect(extensionId).toMatch(/^[a-p]{32}$/u);

    const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
    expect(manifest.manifest_version).toBe(3);
    expect(manifest.permissions ?? []).not.toContain('history');
    expect(manifest.permissions ?? []).not.toContain('cookies');
    expect(manifest.host_permissions ?? []).not.toContain('<all_urls>');

    const demo = context.pages()[0] ?? await context.newPage();
    await demo.goto('http://127.0.0.1:4174');
    await expect(demo.getByRole('heading', { name: 'Invoice reconciliation' })).toBeVisible();
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/panel.html`);
    await demo.bringToFront();

    const invalid = await panel.evaluate(async () => {
      return await chrome.runtime.sendMessage({ type: 'capture.visible-content', payload: {} }) as BrokerResponse;
    });
    expect(invalid.ok).toBe(false);
    expect(invalid.error?.code).toBe('INVALID_MESSAGE');

    const capture = await send(panel, 'capture.visible-content');
    expect(capture.ok).toBe(true);
    const capturedText = String(capture.data?.text ?? '');
    expect(capturedText).toContain('Invoice reconciliation');
    expect(capturedText).toContain('PO-DEMO-1001');
    expect(capturedText).not.toContain('NEVER_CAPTURE_THIS_VALUE');
    expect(capturedText).not.toContain('synthetic.operator');

    const started = await send(panel, 'recording.start');
    expect(started.ok).toBe(true);
    const sessionId = String(started.data?.sessionId ?? '');
    expect(sessionId.length).toBeGreaterThan(10);
    await demo.getByRole('button', { name: 'Approved' }).click();
    await expect.poll(async () => {
      const status = await send(panel, 'recording.status');
      return Number(status.data?.eventCount ?? 0);
    }).toBe(1);
    const stopped = await send(panel, 'recording.stop');
    expect(stopped.ok).toBe(true);
    expect(JSON.stringify(stopped.data?.events ?? [])).toContain('demo.ticket.status.set');
    expect(JSON.stringify(stopped.data?.events ?? [])).not.toContain('NEVER_CAPTURE_THIS_VALUE');

    await send(panel, 'recording.start');
    await demo.goto('http://127.0.0.1:4173');
    const afterNavigation = await send(panel, 'recording.status');
    expect(afterNavigation.ok).toBe(true);
    expect(afterNavigation.data?.recording).toBe(false);

    const panelErrors: string[] = [];
    panel.on('pageerror', (error) => panelErrors.push(error.message));
    await expect(panel.getByRole('heading', { name: 'Bring in only the context you choose.' })).toBeVisible();
    await panel.getByRole('button', { name: 'Memory' }).click();
    await panel.getByRole('button', { name: 'Create new' }).click();
    await panel.getByLabel('Passphrase', { exact: true }).fill('synthetic-extension-vault');
    await panel.getByRole('button', { name: 'Create vault' }).click();
    await expect(panel.getByRole('heading', { name: 'Extension vault unlocked' })).toBeVisible();
    await panel.getByRole('button', { name: 'Lock now' }).click();
    await expect(panel.getByRole('heading', { name: 'Extension vault locked' })).toBeVisible();
    expect(panelErrors).toEqual([]);
  } finally {
    await context?.close();
    if (basename(profile).startsWith('browser-cortex-e2e-') && resolve(profile).startsWith(resolve(tmpdir()))) {
      await rm(profile, { recursive: true, force: true });
    }
  }
});
