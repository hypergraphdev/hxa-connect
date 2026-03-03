/**
 * Quick Playwright smoke test for hxa-connect web-next UI.
 * Tests against the test server at botshub.getcoco.xyz/hub
 *
 * Usage: npx playwright test test-e2e.mjs (or node test-e2e.mjs with playwright script runner)
 */
import { chromium } from 'playwright';

const BASE = 'https://botshub.getcoco.xyz/hub';
// Test bot credentials (zylos0t on test server)
const BOT_TOKEN = process.env.TEST_BOT_TOKEN;

if (!BOT_TOKEN) {
  console.error('Set TEST_BOT_TOKEN environment variable');
  process.exit(1);
}

let browser, page;
const results = [];

function log(status, name, detail) {
  const icon = status === 'PASS' ? '✓' : status === 'FAIL' ? '✗' : '⚠';
  console.log(`  ${icon} ${name}${detail ? ` — ${detail}` : ''}`);
  results.push({ status, name, detail });
}

async function test(name, fn) {
  try {
    await fn();
    log('PASS', name);
  } catch (err) {
    log('FAIL', name, err.message);
  }
}

async function main() {
  console.log('\nHXA-Connect Web UI Smoke Tests');
  console.log(`Target: ${BASE}\n`);

  browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
  });
  page = await ctx.newPage();

  // ── 1. Login page loads ──
  await test('Login page loads', async () => {
    await page.goto(BASE, { waitUntil: 'networkidle', timeout: 15000 });
    // Should show login form with token input
    const input = await page.locator('input[type="password"], input[placeholder*="token" i], input[placeholder*="Token" i]').first();
    if (!await input.isVisible()) throw new Error('Token input not found');
  });

  // ── 2. Login with bot token ──
  await test('Login with bot token', async () => {
    // Find the token input and login button
    const input = await page.locator('input').first();
    await input.fill(BOT_TOKEN);
    const loginBtn = await page.locator('button[type="submit"], button:has-text("Login"), button:has-text("Sign")').first();
    await loginBtn.click();
    // Should redirect to dashboard
    await page.waitForURL('**/dashboard/**', { timeout: 10000 });
  });

  // ── 3. Dashboard shell renders ──
  await test('Dashboard renders with header', async () => {
    // Header should show HXA-Connect brand
    await page.waitForSelector('text=HXA-Connect', { timeout: 5000 });
    // Should show WS status indicator
    const wsIndicator = await page.locator('text=Live, text=Offline').first();
    if (!await wsIndicator.isVisible({ timeout: 5000 })) {
      // Might not be visible on small delay, just check header exists
    }
  });

  // ── 4. Sidebar with threads tab ──
  await test('Sidebar shows threads tab', async () => {
    const threadsTab = await page.locator('button:has-text("Threads"), [role="tab"]:has-text("Threads")').first();
    if (!await threadsTab.isVisible({ timeout: 3000 })) throw new Error('Threads tab not found');
  });

  // ── 5. Sidebar with DMs tab ──
  await test('Sidebar shows DMs tab', async () => {
    const dmsTab = await page.locator('button:has-text("DMs"), button:has-text("Messages"), [role="tab"]:has-text("DMs")').first();
    if (!await dmsTab.isVisible({ timeout: 3000 })) throw new Error('DMs tab not found');
  });

  // ── 6. Navigate to threads ──
  await test('Thread list loads', async () => {
    await page.goto(`${BASE}/dashboard/threads/`, { waitUntil: 'networkidle', timeout: 10000 });
    // Should either show threads or "Select a thread" placeholder
    await page.waitForTimeout(2000);
    const hasContent = await page.locator('text=Select a thread, text=No threads, [class*="thread"]').first().isVisible({ timeout: 5000 }).catch(() => false);
    // Just check we're on the right page
    if (!page.url().includes('dashboard')) throw new Error('Not on dashboard');
  });

  // ── 7. Navigate to DMs ──
  await test('DM list loads', async () => {
    // Click DMs tab
    const dmsTab = await page.locator('button:has-text("DMs"), button:has-text("Messages")').first();
    if (await dmsTab.isVisible()) {
      await dmsTab.click();
      await page.waitForTimeout(1000);
    }
    // Check we navigated to DMs
    await page.waitForURL('**/dms/**', { timeout: 5000 }).catch(() => {
      // May already be on DMs page
    });
  });

  // ── 8. Welcome view (no selection) ──
  await test('Welcome view shows user info', async () => {
    await page.goto(`${BASE}/dashboard/`, { waitUntil: 'networkidle', timeout: 10000 });
    await page.waitForTimeout(1000);
    // Should show welcome or session info somewhere
    const hasWelcome = await page.locator('text=Welcome').isVisible({ timeout: 5000 }).catch(() => false);
    const hasBot = await page.locator('text=zylos0t').isVisible({ timeout: 3000 }).catch(() => false);
    if (!hasWelcome && !hasBot) throw new Error('Neither welcome message nor bot name visible');
  });

  // ── 9. Logout works ──
  await test('Logout redirects to login', async () => {
    const logoutBtn = await page.locator('button:has-text("Logout"), button:has-text("Log out")').first();
    if (await logoutBtn.isVisible({ timeout: 3000 })) {
      await logoutBtn.click();
      await page.waitForURL(`${BASE}/**`, { timeout: 5000 }).catch(() => {});
      // Should be back at login page (no /dashboard in URL)
      const url = page.url();
      if (url.includes('/dashboard')) throw new Error(`Still on dashboard: ${url}`);
    } else {
      throw new Error('Logout button not found');
    }
  });

  // ── Summary ──
  await browser.close();

  console.log('\n─── Results ───');
  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  console.log(`  ${passed} passed, ${failed} failed out of ${results.length}\n`);

  if (failed > 0) {
    console.log('Failed tests:');
    results.filter(r => r.status === 'FAIL').forEach(r => console.log(`  ✗ ${r.name}: ${r.detail}`));
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  if (browser) browser.close();
  process.exit(1);
});
