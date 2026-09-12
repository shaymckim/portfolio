// Run with Node.js and Playwright available: node --test tests/intro.test.cjs
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
let server;
let browser;
let origin;

before(async () => {
  server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    const size = fs.statSync(file).size;
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mp4': 'video/mp4', '.jpg': 'image/jpeg' };
    const headers = { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Accept-Ranges': 'bytes' };
    const range = /bytes=(\d+)-(\d*)/.exec(request.headers.range || '');
    const start = range ? Number(range[1]) : 0;
    const end = range && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    response.writeHead(range ? 206 : 200, { ...headers, 'Content-Length': end - start + 1 });
    const stream = fs.createReadStream(file, { start, end });
    stream.pipe(response);
    response.on('close', () => stream.destroy());
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ channel: 'chrome', headless: true });
});

after(async () => {
  await browser?.close();
  server?.closeAllConnections();
  await new Promise(resolve => server ? server.close(resolve) : resolve());
});

async function openPage(options = {}) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, ...options });
  const page = await context.newPage();
  const errors = [];
  const projectRequests = [];
  page.on('pageerror', error => errors.push(error.message));
  // Keep tests independent of Google Fonts and large, unrelated project assets.
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.fulfill({ body: '' });
    if (/\.(mp4|mov)$/i.test(url.pathname) && url.pathname !== '/vid.mp4') {
      projectRequests.push(url.pathname);
      return route.abort();
    }
    if (/\.(jpeg|jpg|png)$/i.test(url.pathname) && url.pathname !== '/hero-poster.jpg') return route.abort();
    return route.continue();
  });
  return { page, context, errors, projectRequests };
}

async function expectGate(page) {
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('intro-pending')), true);
  assert.equal(await page.locator('#main-content').evaluate(el => el.inert), true);
  assert.equal(await page.locator('header').isVisible(), false);
  assert.equal(await page.locator('#titles-container').isVisible(), false);
}

async function expectComplete(page) {
  await page.waitForFunction(() => document.getElementById('hero').dataset.introState === 'complete', { timeout: 30000 });
  assert.equal(await page.evaluate(() => document.documentElement.classList.contains('intro-pending')), false);
  assert.equal(await page.locator('#main-content').evaluate(el => el.inert), false);
  assert.equal(await page.locator('header').isVisible(), true);
  assert.equal(await page.locator('#intro-loader').isVisible(), false);
  assert.equal(await page.locator('#hero-video').evaluate(video => video.ended), true);
}

test('slow media keeps the themed gate; only the full intro unlocks the portfolio', async () => {
  const { page, context, errors, projectRequests } = await openPage();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  await page.route('**/vid.mp4', async route => { await held; await route.continue(); });
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(3000); // Regression: the former 2.5-second timeout skipped the intro.
    await expectGate(page);
    assert.equal(await page.locator('#intro-loader').isVisible(), true);
    assert.deepEqual(projectRequests, []);
    await page.mouse.wheel(0, 1200);
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => scrollY), 0);
    assert.equal(await page.locator('#main-content').evaluate(el => el.contains(document.activeElement)), false);
    if (process.env.INTRO_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.INTRO_SCREENSHOT_DIR, 'intro-loading-desktop.png') });
    release();
    await page.waitForFunction(() => document.getElementById('hero').dataset.introState === 'playing');
    await expectGate(page);
    assert.equal(await page.locator('#intro-loader').isVisible(), false);
    const duration = await page.locator('#hero-video').evaluate(video => video.duration);
    assert.ok(duration > 0.7);
    await page.waitForFunction(() => document.getElementById('hero-video').currentTime > 0.8);
    await expectGate(page);
    await expectComplete(page);
    await page.keyboard.press('Tab'); // Cancel the optional project scroll.
    await page.locator('.hero-projects').click();
    assert.equal(await page.locator('#project-index').evaluate(dialog => dialog.open), true);
    assert.deepEqual(errors, []);
  } finally { release(); await context.close(); }
});

test('blocked autoplay requires Play intro and never skips the video', async () => {
  const { page, context, errors } = await openPage();
  await page.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play;
    let blocked = false;
    HTMLMediaElement.prototype.play = function () {
      if (this.id === 'hero-video' && !blocked) {
        blocked = true;
        return Promise.reject(new DOMException('Gesture required', 'NotAllowedError'));
      }
      return play.call(this);
    };
  });
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.locator('#intro-play').waitFor({ state: 'visible' });
    await expectGate(page);
    assert.equal(await page.locator('#intro-continue').isVisible(), false);
    await page.locator('#intro-play').click();
    await expectComplete(page);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('media failures offer a working retry without revealing the page', async () => {
  const { page, context, errors } = await openPage();
  let fail = true;
  await page.route('**/vid.mp4', route => fail ? route.abort('failed') : route.continue());
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.locator('#intro-retry').waitFor({ state: 'visible' });
    await expectGate(page);
    fail = false;
    await page.locator('#intro-retry').click();
    await expectComplete(page);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('an unrecoverable media error has an explicit way into the portfolio', async () => {
  const { page, context, errors } = await openPage();
  await page.route('**/vid.mp4', route => route.abort('failed'));
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.locator('#intro-continue').click();
    assert.equal(await page.locator('#hero').getAttribute('data-intro-state'), 'unavailable');
    assert.equal(await page.locator('#main-content').evaluate(el => el.inert), false);
    assert.equal(await page.locator('header').isVisible(), true);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('direct links and reloads play the intro before opening the requested project', async () => {
  const { page, context, errors } = await openPage();
  try {
    await page.goto(`${origin}/#project-4`, { waitUntil: 'domcontentloaded' });
    await expectGate(page);
    assert.equal(await page.evaluate(() => scrollY), 0);
    await expectComplete(page);
    assert.ok(Math.abs(await page.locator('#project-4').evaluate(el => el.getBoundingClientRect().top)) < 2);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expectGate(page);
    await expectComplete(page);
    assert.ok(Math.abs(await page.locator('#project-4').evaluate(el => el.getBoundingClientRect().top)) < 2);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('mobile reduced-motion users get a fitting loading screen and an explicit play control', async () => {
  const { page, context, errors } = await openPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.locator('#intro-play').waitFor({ state: 'visible' });
    await expectGate(page);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.equal(await page.locator('.intro-loading-track').evaluate(el => getComputedStyle(el, '::after').animationName), 'none');
    if (process.env.INTRO_SCREENSHOT_DIR) await page.screenshot({ path: path.join(process.env.INTRO_SCREENSHOT_DIR, 'intro-loading-mobile.png') });
    await page.locator('#intro-play').click();
    await expectComplete(page);
    assert.equal(await page.evaluate(() => scrollY), 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('without JavaScript the static portfolio remains available', async () => {
  const { page, context } = await openPage({ javaScriptEnabled: false });
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    assert.equal(await page.locator('#intro-loader').isVisible(), false);
    assert.equal(await page.locator('.hero-title').isVisible(), true);
    assert.equal(await page.locator('#project-1').isVisible(), true);
  } finally { await context.close(); }
});

test('buffering restores the loading screen and resumes without opening the portfolio', async () => {
  const { page, context, errors } = await openPage();
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('hero').dataset.introState === 'playing');
    await page.locator('#hero-video').evaluate(video => {
      video.dispatchEvent(new Event('waiting'));
      video.pause();
    });
    await expectGate(page);
    assert.equal(await page.locator('#intro-loader').isVisible(), true);
    assert.equal(await page.locator('#intro-status').textContent(), 'Buffering the intro.');
    await page.locator('#hero-video').evaluate(video => video.play());
    await expectComplete(page);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('backgrounding the tab pauses the intro and returning resumes it before reveal', async () => {
  const { page, context, errors } = await openPage();
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('hero').dataset.introState === 'playing');
    await page.evaluate(() => {
      Object.defineProperty(document, 'hidden', { configurable: true, value: true });
      document.dispatchEvent(new Event('visibilitychange'));
    });
    assert.equal(await page.locator('#hero-video').evaluate(video => video.paused), true);
    const pausedAt = await page.locator('#hero-video').evaluate(video => video.currentTime);
    await page.waitForTimeout(1500);
    await expectGate(page);
    assert.equal(await page.locator('#hero-video').evaluate(video => video.currentTime), pausedAt);
    await page.evaluate(() => {
      delete document.hidden;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expectComplete(page);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
