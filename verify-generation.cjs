/* Regression: real proxy + SQLite + browser, with a local-only fixture provider. */
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { randomBytes, createHash } = require('node:crypto');
const { once } = require('node:events');
const sharp = require('sharp');
const HTTP_ONLY = process.env.LUCEN_VERIFY_HTTP_ONLY === '1';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
function check(name, value) { assert.ok(value, name); results.push(name); console.log('PASS  ' + name); }
async function listen(server) { server.listen(0, '127.0.0.1'); await once(server, 'listening'); return server.address().port; }
async function waitFor(test) {
  for (let n = 0; n < 150; n++) { if (await test()) return; await delay(100); }
  throw new Error('Timed out waiting for fixture service/result');
}
async function main() {
  if (!HTTP_ONLY) {
  const build = spawnSync(process.execPath, [path.join(__dirname, 'node_modules/vite/bin/vite.js'), 'build'], { cwd: __dirname, env: { ...process.env, LUCEN_BASE_PATH: '/generate-image' }, encoding: 'utf8', timeout: 120000 });
  assert.equal(build.status, 0, build.stderr || build.stdout);
  }

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucen-generation-'));
  const png = await sharp(randomBytes(1024 * 1024 * 3), { raw: { width: 1024, height: 1024, channels: 3 } }).png().toBuffer();
  const webp = await sharp(png).resize(320).webp().toBuffer();
  const calls = [];
  let releaseDisconnected;
  const upstream = http.createServer(async (req, res) => {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const rawBody = Buffer.concat(chunks);
      const multipart = String(req.headers['content-type'] || '').startsWith('multipart/form-data');
      const form = multipart ? await new Response(rawBody, { headers: { 'Content-Type': req.headers['content-type'] } }).formData() : null;
      const body = form ? Object.fromEntries(form) : chunks.length ? JSON.parse(rawBody) : {};
      const prompt = body.prompt || body.contents?.[0]?.parts?.[0]?.text || '';
      calls.push({ url: req.url, headers: req.headers, prompt, files: form ? await Promise.all([...form.values()].filter(value => typeof value.arrayBuffer === 'function').map(async file => ({name: file.name, bytes: Buffer.from(await file.arrayBuffer())}))) : [] });
      res.setHeader('Content-Type', 'application/json');
      if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'gpt-image-2' }, { id: 'gemini-3.1-flash-image' }] }));
      if (prompt === 'disconnect-fixture') await new Promise(resolve => { releaseDisconnected = resolve; });
      if (prompt === 'empty-fixture') return res.end(JSON.stringify({ candidates: [] }));
      if (prompt === 'failure-fixture') { res.statusCode = 502; return res.end(JSON.stringify({ error: { message: 'fixture provider unavailable' } })); }
      const payload = req.url.includes(':generateContent')
        ? { candidates: [{ content: { parts: [{ inlineData: { mimeType: 'image/webp', data: webp.toString('base64') } }] } }], padding: 'x'.repeat(3 * 1024 * 1024) }
        : { data: [{ b64_json: png.toString('base64'), revised_prompt: 'fixture only' }] };
      res.end(JSON.stringify(payload));
    } catch (error) { res.statusCode = 500; res.end(JSON.stringify({ error: error.message })); }
  });
  const upstreamPort = await listen(upstream);
  const reservation = http.createServer();
  const port = await listen(reservation);
  await new Promise(resolve => reservation.close(resolve));
  const prefix = '/generate-image';
  const origin = 'http://127.0.0.1:' + port;
  const base = origin + prefix;
  const child = spawn(process.execPath, ['lucen-local-proxy.cjs'], {
    cwd: __dirname,
    env: { ...process.env, NODE_ENV: 'test', LUCEN_BASE_PATH: prefix, LUCEN_COOKIE_SECURE: '0', LUCEN_WORKBENCH_HOST: '127.0.0.1', LUCEN_WORKBENCH_PORT: String(port), LUCEN_DATA_DIR: dataDir, LUCEN_ACCESS_PASSWORD: 'browser-password', LUCEN_SESSION_SECRET: 'generation-fixture-secret-0123456789', LUCEN_GPT_API_KEY: 'fixture-gpt-key', LUCEN_GEMINI_API_KEY: 'fixture-gemini-key', LUCEN_TEST_UPSTREAM_BASE_URL: 'http://127.0.0.1:' + upstreamPort },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let childOutput = '';
  child.stdout.on('data', chunk => { childOutput += chunk; });
  child.stderr.on('data', chunk => { childOutput += chunk; });
  let browser;
  try {
    await waitFor(async () => { if (child.exitCode !== null) throw new Error(childOutput); return fetch(base + '/__health').then(r => r.ok).catch(() => false); });
    const login = await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ password: 'browser-password' }) });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const context = { workspaceId: 'fixture-workspace', workspaceTitle: '模拟图片回归' };
    const gptBody = prompt => ({ model: 'gpt-image-2.5', prompt, size: '1024x1024', n: 1 });
    const geminiBody = prompt => ({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { imageConfig: { aspectRatio: '1:1', imageSize: '1K' }, responseModalities: ['IMAGE'] } });
    const gptRoute = '/api/lucen/gpt/images/generations';
    const geminiRoute = '/api/lucen/gemini/v1beta/models/gemini-3.1-flash-image:generateContent';
    const options = (body, ctx = context) => ({ method: 'POST', headers: { Cookie: cookie, Origin: origin, 'Content-Type': 'application/json', ...(ctx ? { 'X-Lucen-Gallery-Context': encodeURIComponent(JSON.stringify(ctx)) } : {}) }, body: JSON.stringify(body) });
    const gallery = () => fetch(base + '/api/local/gallery?limit=80', { headers: { Cookie: cookie } }).then(r => r.json());
    for (const [provider, route, body, original] of [['GPT', gptRoute, gptBody('gpt-fixture'), png], ['Gemini', geminiRoute, geminiBody('gemini-fixture'), webp]]) {
      const response = await fetch(base + route, options(body));
      const text = await response.text();
      const record = JSON.parse(text).lucen?.galleryRecords?.[0];
      check(provider + ' large provider response becomes compact metadata', response.ok && Buffer.byteLength(text) < 4096 && record?.filename && !text.includes('base64') && !text.includes('data:image'));
      check(provider + ' response has exact Content-Length', Number(response.headers.get('content-length')) === Buffer.byteLength(text) && !response.headers.has('transfer-encoding'));
      const saved = (await gallery()).items.find(item => item.id === record.id);
      check(provider + ' gallery is persisted before response', saved?.workspaceId === context.workspaceId && saved.prompt === (body.prompt || body.contents[0].parts[0].text) && saved.mode === 'text');
      const content = await fetch(base + '/api/local/gallery/' + record.id + '/content', { headers: { Cookie: cookie } });
      const bytes = Buffer.from(await content.arrayBuffer());
      check(provider + ' original bytes and SHA-256 are preserved', bytes.equals(original) && saved.contentSha256 === createHash('sha256').update(original).digest('hex'));
      const thumbnail = await fetch(base + '/api/local/gallery/' + record.id + '/thumbnail', { headers: { Cookie: cookie } });
      const meta = await sharp(Buffer.from(await thumbnail.arrayBuffer())).metadata();
      check(provider + ' thumbnail is readable WebP', thumbnail.ok && meta.format === 'webp' && meta.width <= 640);
    }
    check('Session cookie and internal metadata never reach provider', calls.every(call => !call.headers.cookie && !call.headers['x-lucen-gallery-context']) && calls[0].headers.authorization === 'Bearer fixture-gpt-key' && calls[1].headers.authorization === 'Bearer fixture-gemini-key');
    const beforeInvalid = calls.length;
    const invalid = await fetch(base + gptRoute, options(gptBody('invalid-fixture'), { workspaceId: '../bad', workspaceTitle: 'bad' }));
    check('Invalid gallery context is rejected before upstream', invalid.status === 400 && calls.length === beforeInvalid);
    const legacy = await fetch(base + gptRoute, options(gptBody('legacy-fixture'), null));
    const legacyJson = await legacy.json();
    check('Legacy clients keep the original provider response', legacy.ok && legacyJson.data[0].b64_json === png.toString('base64') && (await gallery()).total === 2);
    const empty = await fetch(base + geminiRoute, options(geminiBody('empty-fixture')));
    check('Empty upstream result reports a storage error without losing saved gallery', empty.status === 502 && (await empty.json()).error.code === 'GENERATION_STORAGE_FAILED' && (await gallery()).total === 2);
    const abortController = new AbortController();
    const disconnected = fetch(base + gptRoute, { ...options(gptBody('disconnect-fixture')), signal: abortController.signal }).catch(error => error);
    await waitFor(() => Boolean(releaseDisconnected));
    abortController.abort();
    await disconnected;
    releaseDisconnected();
    await waitFor(async () => (await gallery()).total === 3);
    check('Client disconnect still leaves the generated original in gallery', (await gallery()).items.some(item => item.prompt === 'disconnect-fixture'));

    const editRoute = '/api/lucen/gpt/images/edits';
    const editOptions = (prompt, multi = false) => {
      const form = new FormData(); form.append('model', 'gpt-image-2.5'); form.append('prompt', prompt); form.append('size', 'auto'); form.append('n', '1');
      form.append(multi ? 'image[]' : 'image', new Blob([png], { type: 'image/png' }), 'reference-fixture.png');
      if (multi) form.append('image[]', new Blob([webp], { type: 'image/webp' }), 'second-fixture.webp');
      const init = options({}); delete init.headers['Content-Type']; init.body = form; return init;
    };
    for (const multi of [false, true]) {
      const label = multi ? 'Multiple-image edit' : 'Single-image edit';
      const response = await fetch(base + editRoute, editOptions('direct-edit-fixture-' + multi, multi));
      const text = await response.text(); const record = JSON.parse(text).lucen?.galleryRecords?.[0];
      check(label + ' returns compact persisted edit metadata', response.ok && text.length < 4096 && record?.mode === 'edit' && record.model === 'gpt-image-2.5' && record.size === 'auto' && !text.includes('data:image'));
      const call = calls.at(-1);
      check(label + ' forwards input bytes unchanged without session metadata', call.files.length === (multi ? 2 : 1) && call.files[0].bytes.equals(png) && (!multi || call.files[1].bytes.equals(webp)) && !call.headers.cookie && !call.headers['x-lucen-gallery-context']);
      const original = await fetch(base + '/api/local/gallery/' + record.id + '/content', { headers: {Cookie: cookie} });
      check(label + ' preserves generated original bytes', Buffer.from(await original.arrayBuffer()).equals(png));
      const source = await fetch(origin + record.sourceDataUrl, {headers: {Cookie: cookie}});
      const sourceBytes = Buffer.from(await source.arrayBuffer());
      check(label + ' comparison input uses authenticated binary content', source.ok && sourceBytes.equals(png) && Number(source.headers.get('content-length')) === png.length);
      const blocked = await fetch(origin + record.sourceDataUrl);
      check(label + ' source image rejects unauthenticated access', blocked.status === 401);
    }
    const compactGallery = await fetch(base + '/api/local/gallery?limit=80', {headers: {Cookie: cookie}}).then(r => r.text());
    check('Gallery metadata never embeds edit source Base64', compactGallery.length < 12000 && !compactGallery.includes('data:image'));
    const beforeBadEdit = calls.length;
    const invalidEdit = await fetch(base + editRoute, options({prompt: 'invalid-edit-fixture'}));
    check('Invalid edit multipart rejected before any billable upstream call', invalidEdit.status === 400 && (await invalidEdit.json()).error.code === 'INVALID_GENERATION_REQUEST' && calls.length === beforeBadEdit);
    releaseDisconnected = undefined;
    const editController = new AbortController();
    const editDisconnected = fetch(base + editRoute, { ...editOptions('disconnect-fixture'), signal: editController.signal }).catch(error => error);
    await waitFor(() => Boolean(releaseDisconnected)); editController.abort(); await editDisconnected; releaseDisconnected();
    await waitFor(async () => (await gallery()).items.some(item => item.prompt === 'disconnect-fixture' && item.mode === 'edit'));
    check('Disconnected image edit still persists before any browser upload', (await gallery()).items.some(item => item.prompt === 'disconnect-fixture' && item.mode === 'edit'));

    if (HTTP_ONLY) { console.log('All ' + results.length + ' HTTP-only generation regression checks passed. No real provider used.'); return; }
    const { chromium } = require('playwright-core');
    browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}) });
    const browserContext = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    await browserContext.addCookies([{ name: cookie.split('=')[0], value: cookie.slice(cookie.indexOf('=') + 1), url: origin }]);
    const page = await browserContext.newPage();
    const errors = [];
    let galleryPosts = 0;
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === prefix + '/api/local/gallery') galleryPosts++; });
    await page.goto(base + '/');
    const workspace = page.locator('[data-ws]').first();
    await workspace.waitFor({ state: 'visible' });
    for (const [model, prompt] of [['gpt-image-2.5', 'browser-gpt-fixture'], ['gemini-3.1-flash-image', 'browser-gemini-fixture']]) {
      await workspace.locator('select').first().selectOption(model);
      await workspace.locator('textarea').fill(prompt);
      await workspace.getByRole('button', { name: '开始生成', exact: true }).click();
      const image = workspace.locator('img[alt="fixture only"], img[alt="' + prompt + '"]');
      await image.last().waitFor({ state: 'visible', timeout: 15000 });
      await page.waitForFunction(() => document.body.textContent.includes('完成 1 张'));
      check(model + ' browser renders server-saved image', await image.last().evaluate(img => img.complete && img.naturalWidth > 0));
    }
    await workspace.locator('select').first().selectOption('gpt-image-2.5');
    await workspace.getByRole('button', {name: '图生图', exact: true}).click();
    await workspace.locator('input[type="file"]').setInputFiles({name:'browser-reference.png',mimeType:'image/png',buffer:png});
    await waitFor(() => fs.readdirSync(path.join(dataDir, 'inputs')).length > 0);
    await workspace.locator('textarea').fill('browser-edit-fixture');
    await workspace.getByRole('button', {name: '开始图生图', exact: true}).click();
    await page.waitForFunction(() => document.body.textContent.includes('完成 1 张'));
    const editRecord = (await gallery()).items.find(item => item.prompt === 'browser-edit-fixture');
    check('Modern browser image edit uses server-first persistence', editRecord?.mode === 'edit' && calls.at(-1).url.endsWith('/images/edits'));
    await workspace.locator('img[alt="fixture only"]').first().click();
    await page.getByRole('dialog').waitFor({state:'visible'});
    const compareButton = page.getByRole('button', {name: /对比/}).first();
    await compareButton.click();
    await page.waitForFunction(() => [...document.querySelectorAll('img')].some(img => img.src.endsWith('/source') && img.complete && img.naturalWidth > 0));
    check('Image-edit viewer renders comparison from authenticated source', true);
    await page.keyboard.press('Escape');
    await page.route('**/api/lucen/gpt/images/edits', async route => { await route.fetch(); await route.abort('failed'); });
    await workspace.locator('textarea').fill('browser-lost-edit-fixture'); const beforeLostEdit = calls.length;
    await workspace.getByRole('button', {name: '开始图生图', exact: true}).click();
    await workspace.getByText('生成响应传输中断，请先检查画廊', {exact:true}).waitFor({timeout:15000});
    await page.waitForTimeout(1800);
    check('Interrupted image-edit response is saved and not automatically regenerated', calls.length === beforeLostEdit + 1 && (await gallery()).items.some(item => item.prompt === 'browser-lost-edit-fixture' && item.mode === 'edit'));
    await page.unroute('**/api/lucen/gpt/images/edits');
    await workspace.locator('textarea').fill('failure-fixture'); const beforeEditFailure = calls.length;
    await workspace.getByRole('button', {name: '开始图生图', exact: true}).click();
    await workspace.getByText('生成响应传输中断，请先检查画廊', {exact:true}).waitFor({timeout:15000}); await page.waitForTimeout(1800);
    check('Image-edit upstream 502 is not automatically regenerated', calls.length === beforeEditFailure + 1);
    await page.reload(); await page.locator('[data-ws]').first().waitFor({state:'visible'});
    const lostEdit = (await gallery()).items.find(item => item.prompt === 'browser-lost-edit-fixture');
    await page.locator('img[src*="' + lostEdit.id + '/thumbnail"]').waitFor({state:'visible'});
    check('Image-edit refresh restores server-saved image after lost response', true);
    await workspace.locator('select').first().selectOption('gemini-3.1-flash-image');
    check('Browser does not re-upload generated Base64 to gallery', galleryPosts === 0);
    // Lose only the client response after the real local proxy has saved the image.
    await page.route('**/api/lucen/gemini/**:generateContent', async route => { await route.fetch(); await route.abort('failed'); });
    const beforeLoss = calls.length;
    await workspace.locator('textarea').fill('browser-lost-response-fixture');
    await workspace.getByRole('button', { name: '开始生成', exact: true }).click();
    await workspace.getByText('生成响应传输中断，请先检查画廊', { exact: true }).waitFor({ timeout: 15000 });
    await page.waitForTimeout(1800);
    check('Lost response is not automatically regenerated', calls.length === beforeLoss + 1 && (await gallery()).items.some(item => item.prompt === 'browser-lost-response-fixture'));
    await page.unroute('**/api/lucen/gemini/**:generateContent');
    await workspace.locator('textarea').fill('failure-fixture');
    const beforeFailure = calls.length;
    await workspace.getByRole('button', { name: '开始生成', exact: true }).click();
    await workspace.getByText('生成响应传输中断，请先检查画廊', { exact: true }).waitFor({ timeout: 15000 });
    await page.waitForTimeout(1800);
    check('Ambiguous upstream 502 is not automatically regenerated', calls.length === beforeFailure + 1);
    await page.reload();
    await page.locator('img[alt="browser-lost-response-fixture"]').waitFor({ state: 'visible', timeout: 15000 });
    check('Refresh recovers image saved during lost response', await page.locator('img[alt="browser-lost-response-fixture"]').evaluate(img => img.complete && img.naturalWidth > 0));
    await page.locator('#splash-g').waitFor({ state: 'detached' });
    await page.screenshot({ path: path.join(__dirname, 'output/generation-regression-desktop.png'), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(250);
    check('Mobile result layout has no horizontal overflow', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await page.screenshot({ path: path.join(__dirname, 'output/generation-regression-mobile.png'), fullPage: true });
    check('Browser has no uncaught JavaScript errors', errors.length === 0);
    await page.setViewportSize({width:1440,height:1000});
    await page.goto(base + '/legacy'); const legacyWorkspace = page.locator('.workspace').first();
    await legacyWorkspace.waitFor({state:'visible'});
    await legacyWorkspace.locator('.model-select').selectOption('gpt-image-2.5');
    await legacyWorkspace.locator('[data-mode="edit"]').click();
    await legacyWorkspace.locator('.image-file-input').setInputFiles({name:'legacy-reference.png',mimeType:'image/png',buffer:png});
    await legacyWorkspace.locator('.prompt-input').fill('legacy-browser-edit-fixture');
    await legacyWorkspace.locator('.run-btn').click(); await legacyWorkspace.locator('.workspace-status.ok').waitFor({timeout:15000});
    const legacySaved = (await gallery()).items.find(item => item.prompt === 'legacy-browser-edit-fixture');
    check('Legacy image-edit UI also persists on server without Base64 reupload', legacySaved?.mode === 'edit' && galleryPosts === 0 && await legacyWorkspace.locator('.result img').first().evaluate(img => img.complete && img.naturalWidth > 0));
    const logs = fs.readFileSync(path.join(dataDir, 'lucen-proxy.log'), 'utf8');
    check('Successful generation logs contain metadata without Base64', logs.includes('generation_saved') && !logs.includes(png.toString('base64').slice(0, 100)));
    console.log('\nAll ' + results.length + ' generation regression checks passed. No real provider used.');
  } catch (error) { console.error(childOutput.slice(-3000)); throw error; }
  finally {
    if (browser) await browser.close();
    if (releaseDisconnected) releaseDisconnected();
    const exited = once(child, 'exit');
    if (child.exitCode === null) { child.kill(); await exited; }
    upstream.closeAllConnections();
    await new Promise(resolve => upstream.close(resolve));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}
fs.mkdirSync(path.join(__dirname, 'output'), { recursive: true });
main().catch(error => { console.error(error); process.exitCode = 1; });
