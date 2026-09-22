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

async function extensionWorker(context: BrowserContext): Promise<ServiceWorker> {
  return context.serviceWorkers()[0] ?? await context.waitForEvent('serviceworker');
}

async function panelSend(page: Page, type: string, payload: Record<string, unknown> = {}): Promise<BrokerResponse> {
  return page.evaluate(async ({ messageType, messagePayload }) => {
    return chrome.runtime.sendMessage({
      schemaVersion: 1,
      requestId: crypto.randomUUID(),
      type: messageType,
      payload: messagePayload,
    }) as Promise<BrokerResponse>;
  }, { messageType: type, messagePayload: payload });
}

test('extension vault, grants, demo action, recording, and replay remain document scoped', async () => {
  const profile = await mkdtemp(join(tmpdir(), 'browser-cortex-product-e2e-'));
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
    const demo = context.pages()[0] ?? await context.newPage();
    await demo.goto('http://127.0.0.1:4174');
    const panel = await context.newPage();
    await panel.goto(`chrome-extension://${extensionId}/panel.html`);
    await demo.bringToFront();

    const review = await panelSend(panel, 'grant.review');
    expect(review.ok).toBe(true);
    expect(review.data).toMatchObject({
      origin: 'http://127.0.0.1:4174',
      integrationId: 'northline-demo-v1',
      integrationVersion: '1.0.0',
      recordId: 'PO-DEMO-1001',
    });
    const granted = await panelSend(panel, 'grant.create', { reviewId: review.data?.reviewId });
    expect(granted.ok).toBe(true);
    const grant = granted.data?.grant as Record<string, unknown>;
    const grantId = String(grant.id);

    const unboundDirectWrite = await worker.evaluate(async () => {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === undefined) return { ok: false };
      return chrome.tabs.sendMessage(tab.id, {
        schemaVersion: 1,
        requestId: crypto.randomUUID(),
        type: 'content.integration-write',
        payload: {
          actionId: 'forged-direct-write',
          integrationId: 'northline-demo-v1',
          integrationVersion: '1.0.0',
          recordId: 'PO-DEMO-1001',
          field: 'status',
          from: 'Needs review',
          to: 'Approved',
        },
      }) as Promise<{ ok: boolean }>;
    });
    expect(unboundDirectWrite.ok).toBe(false);
    await expect(demo.locator('[data-bc-demo-current-status]')).toHaveAttribute('data-bc-demo-current-status', 'Needs review');

    const comparison = await panelSend(panel, 'demo.read', { grantId });
    expect(comparison.ok).toBe(true);
    expect(comparison.data?.comparison).toMatchObject({
      quantityDifference: 5,
      monetaryDifferenceMinor: 1_750,
    });

    const writeReview = await panelSend(panel, 'demo.action.preview', { grantId, to: 'Approved' });
    expect(writeReview.ok).toBe(true);
    const write = await panelSend(panel, 'demo.action.execute', { approvalHandle: writeReview.data?.approvalHandle });
    expect(write.ok).toBe(true);
    await expect(demo.locator('[data-bc-demo-current-status]')).toHaveAttribute('data-bc-demo-current-status', 'Approved');

    const run = write.data?.run as Record<string, unknown>;
    const undoReview = await panelSend(panel, 'demo.action.preview', { grantId, undoRunId: run.id });
    expect(undoReview.ok).toBe(true);
    const undo = await panelSend(panel, 'demo.action.execute', { approvalHandle: undoReview.data?.approvalHandle });
    expect(undo.ok).toBe(true);
    await expect(demo.locator('[data-bc-demo-current-status]')).toHaveAttribute('data-bc-demo-current-status', 'Needs review');

    const started = await panelSend(panel, 'recording.start');
    expect(started.ok).toBe(true);
    await demo.getByRole('button', { name: 'Approved' }).click();
    await expect.poll(async () => Number((await panelSend(panel, 'recording.status')).data?.eventCount ?? 0)).toBe(1);
    const stopped = await panelSend(panel, 'recording.stop');
    expect(stopped.ok).toBe(true);
    const compiled = await panelSend(panel, 'recording.compile', {
      recordingId: stopped.data?.recordingId,
      variableName: 'nextStatus',
    });
    expect(compiled.ok).toBe(true);
    expect((compiled.data?.compiled as Record<string, unknown>).kind).toBe('browser-cortex-demo-recording');

    await demo.getByRole('button', { name: 'Needs review' }).click();
    const replayReview = await panelSend(panel, 'workflow.replay.preview', {
      grantId,
      compiled: compiled.data?.compiled,
      inputs: { nextStatus: 'On hold' },
    });
    expect(replayReview.ok).toBe(true);
    const replay = await panelSend(panel, 'demo.action.execute', { approvalHandle: replayReview.data?.approvalHandle });
    expect(replay.ok).toBe(true);
    await expect(demo.locator('[data-bc-demo-current-status]')).toHaveAttribute('data-bc-demo-current-status', 'On hold');

    await demo.locator('[data-bc-demo-tool-name="demo.ticket.status.set"]').evaluate((element) => {
      element.setAttribute('data-bc-demo-tool-effect', 'read');
    });
    const forgedDeclaration = await panelSend(panel, 'grant.review');
    expect(forgedDeclaration.ok).toBe(false);
    expect(forgedDeclaration.error?.code).toBe('GRANT_REVIEW_FAILED');

    await demo.goto('http://127.0.0.1:4174');
    const afterNavigation = await panelSend(panel, 'grant.status');
    expect(afterNavigation.data?.active).toBe(false);

    await demo.bringToFront();
    await panel.getByRole('button', { name: 'Context' }).click();
    await panel.getByRole('button', { name: 'Review visible content' }).click();
    await panel.getByRole('button', { name: 'Memory' }).click();
    await panel.getByRole('button', { name: 'Create new' }).click();
    await panel.getByLabel('Passphrase', { exact: true }).fill('synthetic-extension-product-vault');
    await panel.getByRole('button', { name: 'Create vault' }).click();
    await expect(panel.getByRole('heading', { name: 'Extension vault unlocked' })).toBeVisible();
    await panel.getByRole('button', { name: 'Save reviewed capture' }).click();
    await expect(panel.getByText(/Saved .* as an encrypted extension source/u)).toBeVisible();
    await panel.getByLabel('Search query').fill('quantity exceeds');
    await panel.getByRole('button', { name: 'Search', exact: true }).click();
    await expect(panel.locator('.search-results article')).toHaveCount(1);
    await panel.bringToFront();
    await panel.screenshot({ path: 'release/extension-panel.png', fullPage: true });
    await panel.getByRole('button', { name: 'Delete' }).first().click();
    await panel.getByRole('button', { name: 'Confirm delete' }).click();
    await expect(panel.getByText('No encrypted sources')).toBeVisible();

    const stored = await worker.evaluate(async () => chrome.storage.session.get('browserCortexBrokerSessionV1'));
    expect(stored.browserCortexBrokerSessionV1).toBeDefined();
  } finally {
    await context?.close();
    if (basename(profile).startsWith('browser-cortex-product-e2e-') && resolve(profile).startsWith(resolve(tmpdir()))) {
      await rm(profile, { recursive: true, force: true });
    }
  }
});
