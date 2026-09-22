import { expect, test } from '@playwright/test';

const privateMarker = 'LANTERN-QUARTZ-7319';
const sourceText = `Delivery note ${privateMarker}\nThe revised delivery date is 2026-10-14.\nThis is synthetic browser test data.`;

test('encrypted memory remains useful and the reviewed app shell works offline', async ({ context, page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue temporarily' }).click();
  await expect(page.getByRole('heading', { name: 'Your data. Your models. Your call.' })).toBeVisible();

  await page.getByRole('button', { name: 'Add a source' }).click();
  await page.getByLabel('Vault passphrase').fill('synthetic-passphrase-7319');
  await page.getByRole('button', { name: 'Create vault' }).click();
  await expect(page.getByText('Decryption is active')).toBeVisible();

  await page.locator('input[accept*="text/plain"]').setInputFiles({
    name: 'synthetic-delivery-note.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from(sourceText),
  });
  await expect(page.getByRole('article').getByText('synthetic-delivery-note.txt', { exact: true })).toBeVisible();

  await page.getByLabel('Search query').fill('revised delivery date');
  await page.getByRole('button', { name: 'Search encrypted memory' }).click();
  await expect(page.getByText(/2026-10-14/u)).toBeVisible();
  await page.screenshot({ path: 'release/workbench-overview.png', fullPage: true });

  const indexedDbText = await page.evaluate(async () => {
    function render(value: unknown, seen = new WeakSet<object>()): string {
      if (typeof value === 'string') return value;
      if (value instanceof ArrayBuffer) return new TextDecoder().decode(value);
      if (ArrayBuffer.isView(value)) {
        return new TextDecoder().decode(new Uint8Array(value.buffer, value.byteOffset, value.byteLength));
      }
      if (typeof value !== 'object' || value === null) return String(value ?? '');
      if (seen.has(value)) return '';
      seen.add(value);
      if (Array.isArray(value)) return value.map((item) => render(item, seen)).join('\n');
      return Object.entries(value as Record<string, unknown>)
        .map(([key, item]) => `${key}:${render(item, seen)}`)
        .join('\n');
    }

    const databases = await indexedDB.databases();
    const values: unknown[] = [];
    for (const descriptor of databases) {
      if (!descriptor.name) continue;
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(descriptor.name as string);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error ?? new Error('IndexedDB open failed.'));
      });
      const names = [...database.objectStoreNames];
      if (names.length > 0) {
        const transaction = database.transaction(names, 'readonly');
        for (const name of names) {
          values.push(...await new Promise<unknown[]>((resolve, reject) => {
            const request = transaction.objectStore(name).getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error ?? new Error('IndexedDB read failed.'));
          }));
        }
      }
      database.close();
    }
    return render(values);
  });
  expect(indexedDbText).not.toContain(privateMarker);
  expect(indexedDbText).not.toContain('The revised delivery date is 2026-10-14.');

  await page.getByRole('button', { name: 'Lock now' }).click();
  await expect(page.getByRole('button', { name: 'Unlock vault' })).toBeVisible();

  const registration = await page.evaluate(async () => {
    const ready = await navigator.serviceWorker.ready;
    return ready.active?.scriptURL ?? '';
  });
  expect(registration).toMatch(/service-worker/u);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your data. Your models. Your call.' })).toBeVisible();

  await context.setOffline(true);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Your data. Your models. Your call.' })).toBeVisible();
  await expect(page.getByText('Online processing is off', { exact: true })).toBeVisible();
});

test('online simulation requires configuration, exact disclosure, and one-use approval', async ({ page }) => {
  const outgoing: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/v1/assist')) outgoing.push(request.url());
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue temporarily' }).click();
  await page.getByRole('button', { name: 'Privacy' }).click();
  await page.getByRole('button', { name: /Ask before online/u }).click();
  await page.getByRole('button', { name: 'Configure session' }).click();
  await page.getByLabel('Text').fill('Email demo.user@example.test with the synthetic summary.');
  await page.getByRole('button', { name: 'Create exact disclosure' }).click();

  const requestBody = page.locator('.disclosure-panel pre');
  await expect(requestBody).toBeVisible();
  await expect(requestBody).not.toContainText('demo.user@example.test');
  await expect(page.getByText('SIMULATION', { exact: false }).first()).toBeVisible();
  await page.getByRole('button', { name: 'Approve these exact bytes once' }).click();
  await expect(page.getByText(/Synthetic gateway response/u)).toBeVisible();
  expect(outgoing).toEqual([]);
});

test('onboarding keeps keyboard focus contained and the narrow shell remains operable', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Downloads happen only after review' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Encrypted vault or temporary mode' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue temporarily' }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Set up encrypted vault' })).toBeFocused();
  await page.getByRole('button', { name: 'Continue temporarily' }).click();
  await expect(page.getByRole('heading', { name: 'Your data. Your models. Your call.' })).toBeVisible();
  await page.getByRole('button', { name: 'Open navigation' }).click();
  await expect(page.getByRole('navigation', { name: 'Main navigation' })).toBeVisible();
  await page.getByRole('button', { name: 'Memory' }).click();
  await expect(page.getByRole('heading', { name: 'Sources you explicitly choose' })).toBeVisible();
  const unnamedControls = await page.locator('button, input, select, textarea').evaluateAll((controls) => controls.flatMap((control) => {
    const element = control as HTMLElement;
    if (element.closest('[hidden]') || element.getAttribute('aria-hidden') === 'true') return [];
    const labelled = element.getAttribute('aria-label')
      || (element.getAttribute('aria-labelledby') && document.getElementById(element.getAttribute('aria-labelledby') ?? '')?.textContent)
      || element.closest('label')?.textContent
      || element.textContent
      || (element as HTMLInputElement).placeholder;
    return labelled?.trim() ? [] : [element.outerHTML.slice(0, 160)];
  }));
  expect(unnamedControls).toEqual([]);
});

test('workflow export requires a fresh exact-row preview before one-use approval', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue temporarily' }).click();
  await page.getByRole('button', { name: 'Workflows' }).click();
  await page.getByRole('button', { name: 'Compile plan' }).click();
  await expect(page.getByLabel('Workflow JSON')).toBeVisible();
  await page.getByRole('button', { name: 'Review exact export' }).click();
  await expect(page.getByText('Local file write awaiting approval')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Approve these exact rows once' })).toBeVisible();

  const csv = page.getByLabel('CSV input');
  await csv.fill(`${await csv.inputValue()}\nDEMO-005,DE,4200,USD`);
  await expect(page.getByRole('button', { name: 'Approve these exact rows once' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Review exact export' }).click();
  await expect(page.getByText(/3 data rows/u)).toBeVisible();
  await page.getByRole('button', { name: 'Approve these exact rows once' }).click();
  await expect(page.getByRole('button', { name: /Download .*reviewed/u })).toBeVisible();
});
