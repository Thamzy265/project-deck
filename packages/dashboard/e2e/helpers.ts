import { AxeBuilder } from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import { expect } from '@playwright/test';
import { join } from 'node:path';
import { ARTIFACTS } from './daemons.js';

interface Watch {
  cspViolations: string[];
  consoleErrors: string[];
}

/**
 * Records CSP violations and console errors. The daemon's CSP is strict
 * (`default-src 'self'`), so any inline script or style in the build shows up here.
 */
export async function watchPage(page: Page): Promise<Watch> {
  const watch: Watch = { cspViolations: [], consoleErrors: [] };
  await page.exposeFunction('__reportCsp', (directive: string) =>
    watch.cspViolations.push(directive),
  );
  await page.addInitScript(() => {
    document.addEventListener('securitypolicyviolation', (e) => {
      (window as unknown as { __reportCsp: (d: string) => void }).__reportCsp(
        `${e.violatedDirective} ${e.blockedURI}`,
      );
    });
  });
  page.on('console', (msg) => {
    if (msg.type() === 'error') watch.consoleErrors.push(msg.text());
  });
  return watch;
}

export async function openDashboard(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await expect(page.getByRole('contentinfo')).toContainText('Connected');
}

/** The M2 checks are about logs; since M3 the page opens on the Database tab. */
export async function openLogs(page: Page, url: string): Promise<void> {
  await openDashboard(page, url);
  await page.getByRole('tab', { name: 'Logs' }).click();
}

export async function expectNoSidewaysScroll(page: Page): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** No serious or critical axe-core violations (WCAG 2.x A and AA rules). */
export async function expectAccessible(page: Page): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  const bad = result.violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`);
  expect(bad).toEqual([]);
}

/** M3 Database tab screenshots for QA (qa-artifacts/ is git-ignored). */
export async function screenshotM3(page: Page, name: string): Promise<void> {
  await page.screenshot({
    path: join(ARTIFACTS, '..', 'm3-database-tab', 'screens', `${name}.png`),
    fullPage: true,
  });
}

export async function screenshot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(ARTIFACTS, 'screens', `${name}.png`), fullPage: true });
}
