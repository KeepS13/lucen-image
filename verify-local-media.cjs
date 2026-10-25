const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');
const sharp = require('sharp');
const {
  DEFAULT_RETENTION_DAYS,
  MIN_RETENTION_DAYS,
  MAX_RETENTION_DAYS,
  createLocalMediaManager,
  detectImageMime,
} = require('./local-media.cjs');

const DAY = 86400000;
let checks = 0;
function check(name, condition) {
  assert.ok(condition, name);
  checks += 1;
  console.log('PASS  ' + name);
}

function makeTemp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'lucen-local-media-'));
}

async function makePng() {
  return sharp({ create: { width: 800, height: 600, channels: 3, background: '#3b82f6' } })
    .png().toBuffer();
}

function makeInput(id, createdAt) {
  return { id, filename: id + '.png', name: id + '.png', type: 'image/png', createdAt };
}

function addInput(dataDir, db, input, bytes) {
  fs.mkdirSync(path.join(dataDir, 'inputs'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'inputs', input.filename), bytes);
  db.prepare('INSERT INTO inputs (id,filename,name,type,createdAt) VALUES (?,?,?,?,?)')
    .run(input.id, input.filename, input.name, input.type, input.createdAt);
}

async function testMediaAndExpiry() {
  const dataDir = makeTemp();
  let now = 1_700_000_000_000;
  const db = new Database(path.join(dataDir, 'lucen.db'));
  const failures = [];
  const manager = createLocalMediaManager({ db, dataDir, now: () => now, logger: (event) => failures.push(event) });
  await manager.start();
  const png = await makePng();
  const record = await manager.createGallery({
    id: 'image-old', workspaceId: 'w1', workspaceTitle: 'test', prompt: 'blue',
    revisedPrompt: '', model: 'gpt-image-2', size: '1024x1024', mode: 'text', createdAt: now,
  }, png, 'image/png');
  check('original and thumbnail paths are recorded', Boolean(record.filename && record.thumbnailReady));
  check('MIME detection matches PNG', detectImageMime(png) === 'image/png');
  const content = await manager.getContent(record.id);
  const thumbnail = await manager.getThumbnail(record.id);
  check('original bytes round-trip unchanged', content.buffer.equals(png));
  check('thumbnail is WebP and below size limit', thumbnail.mime === 'image/webp' && thumbnail.buffer.length < 100000);
  check('default retention is 30 days', manager.getStorageStatus().retentionDays === DEFAULT_RETENTION_DAYS);
  check('gallery expires at created + retention', record.expiresAt === now + DEFAULT_RETENTION_DAYS * DAY);

  db.prepare('UPDATE gallery SET favorite=1 WHERE id=?').run(record.id);
  now += 31 * DAY;
  const favoriteCleanup = await manager.runCleanup();
  check('favorite image is exempt from expiry', favoriteCleanup.deleted === 0 && Boolean(manager.getGallery(record.id)));
  db.prepare('UPDATE gallery SET favorite=0 WHERE id=?').run(record.id);
  const unfavoriteCleanup = await manager.runCleanup();
  check('unfavorite immediately expires old image', unfavoriteCleanup.deleted === 1 && !manager.getGallery(record.id));
  check('expired files were removed', !fs.existsSync(path.join(dataDir, 'images', record.filename)) && !fs.existsSync(path.join(dataDir, 'thumbnails', record.id + '.thumb.webp')));

  addInput(dataDir, db, makeInput('input-old', now - 31 * DAY), png);
  const inputResult = await manager.runCleanup();
  check('old edit input is cleaned', inputResult.deleted === 1 && db.prepare('SELECT COUNT(*) c FROM inputs').get().c === 0);

  for (const value of [MIN_RETENTION_DAYS, MAX_RETENTION_DAYS]) {
    const result = await manager.updateRetentionDays(value);
    check('retention ' + value + ' is accepted', result.retentionDays === value && Number.isInteger(result.deleted));
  }
  for (const value of [0, 3651, 1.5, 'abc']) {
    await assert.rejects(() => manager.updateRetentionDays(value), /between 1 and 3650/);
  }
  check('invalid retention values are rejected', true);

  await manager.updateRetentionDays(1);
  const fresh = await manager.createGallery({
    id: 'image-fail', workspaceId: 'w1', workspaceTitle: 'test', prompt: 'failure',
    model: 'gpt-image-2', size: '1024x1024', mode: 'text', createdAt: now - 2 * DAY,
  }, png, 'image/png');
  const originalPath = path.join(dataDir, 'images', fresh.filename);
  const lockedDir = originalPath + '.locked';
  fs.renameSync(originalPath, lockedDir);
  fs.mkdirSync(originalPath);
  fs.writeFileSync(path.join(originalPath, 'child'), 'locked');
  const failedCleanup = await manager.runCleanup();
  check('cleanup failure keeps database row', failedCleanup.failures.length === 1 && Boolean(manager.getGallery(fresh.id)));
  fs.rmSync(originalPath, { recursive: true, force: true });
  fs.renameSync(lockedDir, originalPath);
  const retryCleanup = await manager.runCleanup();
  check('next cleanup retries failed record', retryCleanup.failures.length === 0 && !manager.getGallery(fresh.id));

  manager.stop();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

async function testFreshDatabaseSchema() {
  const dataDir = makeTemp();
  const db = new Database(path.join(dataDir, 'lucen.db'));
  db.exec(`CREATE TABLE gallery (
    id TEXT PRIMARY KEY, workspaceId TEXT, workspaceTitle TEXT, prompt TEXT,
    revisedPrompt TEXT, model TEXT, size TEXT, mode TEXT, filename TEXT, url TEXT,
    sourceDataUrl TEXT, favorite INTEGER DEFAULT 0, createdAt INTEGER
  );`);
  const manager = createLocalMediaManager({ db, dataDir, now: Date.now });
  await manager.start();
  const record = await manager.createGallery({
    id: 'fresh-image', workspaceId: 'w', workspaceTitle: 'fresh', prompt: 'fresh',
    model: 'gpt-image-2', size: '1024x1024', mode: 'text', createdAt: Date.now(),
  }, await makePng(), 'image/png');
  check('fresh local database supports media columns', record.id === 'fresh-image' && Boolean(record.filename));
  manager.stop();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

async function testMigrationReset() {
  const dataDir = makeTemp();
  const dbPath = path.join(dataDir, 'lucen.db');
  let db = new Database(dbPath);
  db.exec(`
    CREATE TABLE gallery (id TEXT PRIMARY KEY, workspaceId TEXT, workspaceTitle TEXT, prompt TEXT,
      revisedPrompt TEXT, model TEXT, size TEXT, mode TEXT, filename TEXT, url TEXT,
      sourceDataUrl TEXT, favorite INTEGER DEFAULT 0, createdAt INTEGER,
      remoteUrl TEXT, mime TEXT, contentSha256 TEXT, uploadStatus TEXT, uploadAttempts INTEGER DEFAULT 0,
      nextRetryAt INTEGER, lastUploadError TEXT, uploadedAt INTEGER, thumbnailUrl TEXT,
      thumbnailMime TEXT, thumbnailSha256 TEXT, thumbnailStatus TEXT, thumbnailAttempts INTEGER DEFAULT 0,
      thumbnailNextRetryAt INTEGER, thumbnailLastUploadError TEXT, thumbnailUploadedAt INTEGER,
      thumbnailByteSize INTEGER);
    CREATE TABLE image_upload_jobs (galleryId TEXT, variant TEXT, PRIMARY KEY(galleryId,variant));
    CREATE TABLE inputs (id TEXT PRIMARY KEY, filename TEXT, name TEXT, type TEXT, createdAt INTEGER);
  `);
  db.prepare("INSERT INTO gallery (id,filename,mime,createdAt,remoteUrl,uploadStatus) VALUES ('old-image','old.png','image/png',?, '','pending')").run(Date.now());
  db.prepare("INSERT INTO image_upload_jobs (galleryId,variant) VALUES ('old-image','original')").run();
  fs.mkdirSync(path.join(dataDir, 'pending-uploads'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'pending-uploads', 'old.png'), await makePng());
  fs.writeFileSync(path.join(dataDir, 'pending-uploads', 'old-image.thumb.webp'), 'thumb');
  db.close();

  db = new Database(dbPath);
  const manager = createLocalMediaManager({ db, dataDir, now: Date.now });
  const started = await manager.start();
  check('one-time migration reports reset', started.migration.reset === true);
  check('legacy gallery rows are deleted', manager.getStorageStatus().galleryCount === 0);
  check('legacy jobs table is removed', !db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='image_upload_jobs'").get());
  check('legacy pending files are removed', fs.readdirSync(path.join(dataDir, 'pending-uploads')).length === 0);
  const columns = db.prepare('PRAGMA table_info(gallery)').all().map((row) => row.name);
  check('gallery schema has only local fields', columns.includes('thumbnailFilename') && !columns.includes('remoteUrl') && !columns.includes('uploadStatus') && !columns.includes('thumbnailStatus'));

  db.prepare("INSERT INTO gallery (id,workspaceId,prompt,filename,createdAt,mime) VALUES ('new-image','w','new','new.png',?, 'image/png')").run(Date.now());
  manager.stop();
  db.close();
  db = new Database(dbPath);
  const second = createLocalMediaManager({ db, dataDir, now: Date.now });
  const secondStart = await second.start();
  check('migration reset runs only once', secondStart.migration.reset === false && second.getStorageStatus().galleryCount === 1);
  second.stop();
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
}

(async () => {
  await testMediaAndExpiry();
  await testFreshDatabaseSchema();
  await testMigrationReset();
  console.log('\nAll ' + checks + ' local media checks passed.');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
