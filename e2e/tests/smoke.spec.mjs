import { test, expect } from '@playwright/test';

test('local fixture renders, is interactive, and screenshots', async ({ page }, testInfo) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Yonder e2e fixture' })).toBeVisible();
  await page.getByRole('button', { name: 'Click me' }).click();
  await expect(page.locator('#out')).toBeVisible();
  const png = await page.screenshot({ path: testInfo.outputPath('fixture.png'), fullPage: true });
  expect(png.byteLength).toBeGreaterThan(1000);
});

test('example.com loads and screenshots', async ({ page }, testInfo) => {
  test.skip(!!process.env.E2E_OFFLINE, 'offline');
  await page.goto('https://example.com/');
  await expect(page.getByRole('heading', { name: 'Example Domain' })).toBeVisible();
  const png = await page.screenshot({ path: testInfo.outputPath('example.png') });
  expect(png.byteLength).toBeGreaterThan(1000);
});
