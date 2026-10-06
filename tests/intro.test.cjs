// Run with Node.js and Playwright available: node --test tests/intro.test.cjs
const { before, after, test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
let server;
let browser;
let origin;
let introStreamGate;

before(async () => {
  server = http.createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, 'http://localhost').pathname);
    const file = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file)) {
      response.writeHead(404).end();
      return;
    }
    const size = fs.statSync(file).size;
    const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.mp4': 'video/mp4', '.jpg': 'image/jpeg', '.webp': 'image/webp' };
    const headers = { 'Content-Type': types[path.extname(file)] || 'application/octet-stream', 'Accept-Ranges': 'bytes' };
    const range = /bytes=(\d+)-(\d*)/.exec(request.headers.range || '');
    const start = range ? Number(range[1]) : 0;
    const end = range && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
    response.writeHead(range ? 206 : 200, { ...headers, 'Content-Length': end - start + 1 });
    if (pathname === '/intro-video.mp4' && introStreamGate) {
      const bytes = fs.readFileSync(file);
      const split = Math.floor(bytes.length * 0.65);
      response.write(bytes.subarray(0, split));
      introStreamGate.then(() => response.end(bytes.subarray(split)));
      return;
    }
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
    if (/\.(mp4|mov)$/i.test(url.pathname) && url.pathname !== '/intro-video.mp4') {
      projectRequests.push(url.pathname);
      return route.abort();
    }
    if (/\.(jpeg|jpg|png|webp)$/i.test(url.pathname) && url.pathname !== '/media/intro-poster.webp') return route.abort();
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
  await page.route('**/intro-video.mp4', async route => { await held; await route.continue(); });
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
  await page.route('**/intro-video.mp4', route => fail ? route.abort('failed') : route.continue());
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
  await page.route('**/intro-video.mp4', route => route.abort('failed'));
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

test('waiting and pauses never restore the loader after the first visible frame', async () => {
  const { page, context, errors } = await openPage();
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => document.getElementById('hero').dataset.introState === 'playing');
    await page.locator('#hero-video').evaluate(video => {
      video.dispatchEvent(new Event('waiting'));
      video.pause();
    });
    await expectGate(page);
    assert.equal(await page.locator('#intro-loader').isVisible(), false);
    await page.locator('#intro-resume').click();
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
    assert.equal(await page.locator('#intro-loader').isVisible(), false);
    assert.equal(await page.locator('#hero-video').evaluate(video => video.currentTime), pausedAt);
    await page.evaluate(() => {
      delete document.hidden;
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await expectComplete(page);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('a partial download cannot flash the video; the completed download plays entirely offline', async () => {
  const { page, context, errors } = await openPage();
  let release;
  introStreamGate = new Promise(resolve => { release = resolve; });
  const requests = [];
  page.on('request', request => {
    if (request.url().endsWith('/intro-video.mp4')) requests.push(request);
  });
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => {
      const loader = document.getElementById('intro-loader');
      window.loaderStates = [loader.hidden];
      new MutationObserver(() => window.loaderStates.push(loader.hidden))
        .observe(loader, { attributes: true, attributeFilter: ['hidden'] });
    });
    await page.waitForTimeout(1500);
    await expectGate(page);
    assert.equal(await page.locator('#intro-loader').isVisible(), true);
    assert.equal(await page.locator('#hero-video').evaluate(video => video.currentTime), 0);
    assert.equal(await page.locator('#hero-video').getAttribute('src'), null);
    release();
    await page.waitForFunction(() => document.getElementById('hero').dataset.introState === 'playing');
    assert.match(await page.locator('#hero-video').getAttribute('src'), /^blob:/);
    await context.setOffline(true);
    await expectComplete(page);
    const states = await page.evaluate(() => window.loaderStates);
    const reveal = states.indexOf(true);
    assert.ok(reveal >= 0);
    assert.ok(states.slice(reveal).every(Boolean), JSON.stringify(states));
    assert.equal(requests.length, 1);
    assert.equal(requests[0].resourceType(), 'fetch');
    assert.deepEqual(errors, []);
  } finally {
    release();
    introStreamGate = null;
    await context.close();
  }
});

test('slow fonts do not delay playback or move the loading screen', async () => {
  const { page, context, errors } = await openPage();
  let release;
  let releaseFonts;
  const held = new Promise(resolve => { release = resolve; });
  const heldFonts = new Promise(resolve => { releaseFonts = resolve; });
  await page.route('**/intro-video.mp4', async route => { await held; await route.continue(); });
  await page.route('https://fonts.googleapis.com/**', async route => { await heldFonts; await route.fulfill({ body: '' }); });
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    const before = await page.locator('.intro-monogram').boundingBox();
    // The slow-download hint adds a retry button without shifting the content.
    await page.clock.install();
    await page.clock.fastForward(13000);
    await page.locator('#intro-retry').waitFor({ state: 'visible' });
    assert.deepEqual(await page.locator('.intro-monogram').boundingBox(), before);
    assert.equal(await page.locator('#intro-loader').isVisible(), true);
    release();
    await expectComplete(page);
    assert.deepEqual(errors, []);
  } finally { release(); releaseFonts(); await context.close(); }
});

test('opening index.html directly plays the intro without using fetch on local files', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  const localFetches = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (request.url().startsWith('file:') && request.resourceType() === 'fetch') localFetches.push(request.url());
  });
  await page.route('https://**', route => route.fulfill({ body: '' }));
  try {
    await page.goto(pathToFileURL(path.join(root, 'index.html')).href, { waitUntil: 'domcontentloaded' });
    await expectComplete(page);
    assert.match(await page.locator('#hero-video').evaluate(video => video.currentSrc), /^file:.*intro-video\.mp4$/);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expectComplete(page);
    assert.deepEqual(localFetches, []);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('a blocked fetch falls back to native media and still waits for the complete file', async () => {
  const { page, context, errors } = await openPage();
  let release;
  introStreamGate = new Promise(resolve => { release = resolve; });
  await page.route('**/intro-video.mp4', route => route.request().resourceType() === 'fetch' ? route.abort('failed') : route.continue());
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await expectGate(page);
    assert.equal(await page.locator('#intro-loader').getAttribute('data-state'), 'loading');
    assert.equal(await page.locator('#hero-video').evaluate(video => video.currentTime), 0);
    release();
    await expectComplete(page);
    assert.equal(await page.locator('#hero-video').evaluate(video => video.currentSrc), `${origin}/intro-video.mp4`);
    assert.deepEqual(errors, []);
  } finally { release(); introStreamGate = null; await context.close(); }
});

test('a browser that rejects blob playback falls back to the normal video URL', async () => {
  const { page, context, errors } = await openPage();
  await page.addInitScript(() => {
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      if (this.id === 'hero-video' && this.src.startsWith('blob:')) {
        return Promise.reject(new DOMException('Blob playback unavailable', 'NotSupportedError'));
      }
      return play.call(this);
    };
  });
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await expectComplete(page);
    assert.equal(await page.locator('#hero-video').evaluate(video => video.currentSrc), `${origin}/intro-video.mp4`);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('retry discards a failed media source and downloads a fresh copy', async () => {
  const { page, context, errors } = await openPage();
  let corrupt = true;
  let fetches = 0;
  await page.route('**/intro-video.mp4', route => {
    if (route.request().resourceType() === 'fetch') fetches++;
    return corrupt ? route.fulfill({ contentType: 'video/mp4', body: 'Invalid cached video' }) : route.continue();
  });
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await page.locator('#intro-retry').waitFor({ state: 'visible' });
    await expectGate(page);
    corrupt = false;
    await page.locator('#intro-retry').click();
    await expectComplete(page);
    assert.equal(fetches, 2);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('the first frame is the loading screen; status fades in only when the download is slow', async () => {
  const { page, context, errors } = await openPage();
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const order = [];
  page.on('request', request => {
    const { pathname } = new URL(request.url());
    if (pathname === '/media/intro-poster.webp' || pathname === '/intro-video.mp4') order.push(pathname);
  });
  await page.route('**/intro-video.mp4', async route => { await held; await route.continue(); });
  try {
    const poster = page.waitForResponse(response => response.url().endsWith('/media/intro-poster.webp'));
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await poster;
    // The small poster is requested ahead of the clip, so the frame paints first.
    assert.deepEqual(order, ['/media/intro-poster.webp', '/intro-video.mp4']);
    assert.match(await page.locator('#hero-video').evaluate(video => video.poster), /\/media\/intro-poster\.webp$/);
    assert.equal(await page.locator('#intro-loader').evaluate(el => getComputedStyle(el).opacity), '0');
    await page.waitForFunction(() => getComputedStyle(document.getElementById('intro-loader')).opacity === '1', null, { timeout: 4000 });
    await expectGate(page);
    release();
    await expectComplete(page);
    assert.deepEqual(errors, []);
  } finally { release(); await context.close(); }
});

test('project media keeps its final shape before loading, and videos buffer ahead and play only on screen', async () => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  const videos = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith('/media/video/') && pathname.endsWith('.mp4')) videos.push(pathname);
  });
  await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.fulfill({ body: '' }));
  try {
    await page.goto(origin, { waitUntil: 'domcontentloaded' });
    await expectComplete(page);
    await page.keyboard.press('Tab'); // Cancel the optional project scroll.
    await page.waitForFunction(() => document.querySelector('#project-1 video').preload === 'auto');
    assert.ok(!videos.some(name => /trebuchet|optitrack|16ft/.test(name)), JSON.stringify(videos));
    // Nothing below the fold has loaded, yet every box already has its media's proportions.
    const shapes = await page.evaluate(() => [...document.querySelectorAll('.section img, .section video')]
      .filter(el => el.tagName === 'VIDEO' ? el.readyState === 0 : !el.complete)
      .map(el => {
        const { width, height } = el.getBoundingClientRect();
        return { src: el.currentSrc || el.querySelector('source')?.getAttribute('src'), width, height,
          expected: width * el.getAttribute('height') / el.getAttribute('width') };
      }));
    assert.ok(shapes.length > 10, `only ${shapes.length} unloaded media elements`);
    for (const shape of shapes) assert.ok(shape.width > 200 && Math.abs(shape.height - shape.expected) < 2, JSON.stringify(shape));
    // Jumping to project 7 smooth-scrolls past three videos; none of them may start downloading.
    await page.locator('.toc-dot[data-target="project-7"]').evaluate(dot => dot.click());
    await page.waitForFunction(() => { const v = document.querySelector('#project-7 video'); return !v.paused && v.currentTime > 0.2; });
    assert.match(await page.locator('#project-7 video').evaluate(video => video.poster), /trebuchet-poster\.webp$/);
    assert.equal(await page.locator('#project-1 video').evaluate(video => video.paused), true);
    assert.ok(!videos.some(name => /quickstep|optitrack|16ft/.test(name)), JSON.stringify(videos));
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});
