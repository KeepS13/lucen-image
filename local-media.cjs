const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sharp = require('sharp');

const DEFAULT_RETENTION_DAYS = 30;
const MIN_RETENTION_DAYS = 1;
const MAX_RETENTION_DAYS = 3650;
const DAY_MS = 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 60 * 1000;
const THUMBNAIL_MAX_BYTES = 100000;
const THUMBNAIL_MAX_EDGE = 640;
const THUMBNAIL_MIN_SHORT_EDGE = 256;
const SUPPORTED_MIMES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MIME_EXTENSIONS = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

class BlockedMediaError extends Error {
  constructor(message) { super(message); this.name = 'BlockedMediaError'; }
}

function normalizeMime(value) {
  const mime = String(value || '').split(';', 1)[0].trim().toLowerCase();
  return mime === 'image/jpg' ? 'image/jpeg' : mime;
}

function mimeFromFilename(filename) {
  const ext = path.extname(String(filename || '')).toLowerCase();
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  return '';
}

function extensionForMime(mime) { return MIME_EXTENSIONS[normalizeMime(mime)] || ''; }
function sha256(buffer) { return crypto.createHash('sha256').update(buffer).digest('hex'); }

function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return '';
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'image/jpeg';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return '';
}

function safeLocalPath(dataDir, relative) {
  if (!relative || typeof relative !== 'string') return '';
  const root = path.resolve(dataDir);
  const target = path.resolve(root, relative);
  return target.startsWith(root + path.sep) ? target : '';
}

async function writeAtomic(filePath, buffer) {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });
  const partial = filePath + '.part-' + process.pid + '-' + Date.now() + '-' + crypto.randomBytes(4).toString('hex');
  await fs.promises.writeFile(partial, buffer);
  await fs.promises.rename(partial, filePath);
}

async function unlinkIfExists(filePath) {
  if (!filePath) return;
  try { await fs.promises.unlink(filePath); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

async function compressThumbnail(buffer) {
  const metadata = await sharp(buffer, { failOn: 'error' }).metadata();
  const originalWidth = metadata.width || 0;
  const originalHeight = metadata.height || 0;
  if (!originalWidth || !originalHeight) throw new BlockedMediaError('Image dimensions are unavailable.');
  const qualities = [82, 72, 62, 52, 42, 32, 24, 18];
  let width = Math.min(THUMBNAIL_MAX_EDGE, originalWidth);
  let best = null;
  while (true) {
    for (const quality of qualities) {
      const encoded = await sharp(buffer, { failOn: 'error' })
        .rotate().resize({ width, withoutEnlargement: true }).webp({ quality, effort: 6 })
        .toBuffer({ resolveWithObject: true });
      if (!best || encoded.data.length < best.data.length) best = encoded;
      if (encoded.data.length < THUMBNAIL_MAX_BYTES) {
        return { buffer: encoded.data, mime: 'image/webp', byteSize: encoded.data.length, width: encoded.info.width, height: encoded.info.height };
      }
    }
    const bestWidth = best && best.info.width ? best.info.width : width;
    const bestHeight = best && best.info.height ? best.info.height : Math.round((originalHeight / originalWidth) * width);
    if (Math.min(bestWidth, bestHeight) <= THUMBNAIL_MIN_SHORT_EDGE) break;
    width = Math.max(1, Math.floor(width * 0.85));
  }
  throw new BlockedMediaError('Image cannot be compressed below 100000 bytes as WebP.');
}

const GALLERY_COLUMNS = [
  'id', 'workspaceId', 'workspaceTitle', 'prompt', 'revisedPrompt', 'model', 'size', 'mode',
  'filename', 'url', 'sourceDataUrl', 'favorite', 'createdAt', 'mime', 'contentSha256',
  'thumbnailFilename', 'thumbnailMime', 'thumbnailSha256', 'thumbnailByteSize',
];

function createSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS storage_migrations (
      name TEXT PRIMARY KEY,
      appliedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS storage_settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      retentionDays INTEGER NOT NULL,
      lastCleanupAt INTEGER,
      lastDeletedCount INTEGER NOT NULL DEFAULT 0,
      lastError TEXT,
      updatedAt INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS gallery (
      id TEXT PRIMARY KEY,
      workspaceId TEXT,
      workspaceTitle TEXT,
      prompt TEXT,
      revisedPrompt TEXT,
      model TEXT,
      size TEXT,
      mode TEXT,
      filename TEXT,
      url TEXT,
      sourceDataUrl TEXT,
      favorite INTEGER DEFAULT 0,
      createdAt INTEGER,
      mime TEXT,
      contentSha256 TEXT,
      thumbnailFilename TEXT,
      thumbnailMime TEXT,
      thumbnailSha256 TEXT,
      thumbnailByteSize INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_gallery_workspace ON gallery(workspaceId);
    CREATE INDEX IF NOT EXISTS idx_gallery_created ON gallery(createdAt);
    CREATE INDEX IF NOT EXISTS idx_gallery_favorite ON gallery(favorite);
    CREATE TABLE IF NOT EXISTS inputs (
      id TEXT PRIMARY KEY,
      filename TEXT,
      name TEXT,
      type TEXT,
      createdAt INTEGER
    );
  `);
  db.prepare(`INSERT OR IGNORE INTO storage_settings
    (id,retentionDays,lastCleanupAt,lastDeletedCount,lastError,updatedAt)
    VALUES (1,?,NULL,0,NULL,?)`).run(DEFAULT_RETENTION_DAYS, Date.now());
}

function createLocalMediaManager(options) {
  const db = options.db;
  const dataDir = path.resolve(options.dataDir);
  const now = options.now || Date.now;
  const cleanupIntervalMs = options.cleanupIntervalMs || CLEANUP_INTERVAL_MS;
  const logger = options.logger || (() => undefined);
  const imagesDir = path.join(dataDir, 'images');
  const thumbnailsDir = path.join(dataDir, 'thumbnails');
  const inputsDir = path.join(dataDir, 'inputs');
  const legacyPendingDir = path.join(dataDir, 'pending-uploads');

  createSchema(db);
  fs.mkdirSync(imagesDir, { recursive: true });
  fs.mkdirSync(thumbnailsDir, { recursive: true });
  fs.mkdirSync(inputsDir, { recursive: true });

  let timer = null;
  let stopped = true;
  let cleanupPromise = null;
  let nextCleanupAt = 0;
  let lastError = null;

  function settingsRow() {
    return db.prepare('SELECT * FROM storage_settings WHERE id=1').get();
  }

  function retentionDays() {
    return Number(settingsRow()?.retentionDays || DEFAULT_RETENTION_DAYS);
  }

  function expiresAt(createdAt, favorite = 0) {
    if (favorite) return null;
    return Number(createdAt) + retentionDays() * DAY_MS;
  }

  function decorate(record) {
    if (!record) return null;
    const output = { ...record };
    output.thumbnailReady = Boolean(
      output.thumbnailFilename && fs.existsSync(safeLocalPath(dataDir, output.thumbnailFilename))
    );
    output.expiresAt = expiresAt(output.createdAt, output.favorite);
    delete output.thumbnailFilename;
    return output;
  }

  function getGallery(id) {
    return decorate(db.prepare('SELECT * FROM gallery WHERE id=?').get(id));
  }

  function listGallery(filters = {}) {
    const where = [];
    const values = [];
    if (filters.workspaceId) { where.push('workspaceId=?'); values.push(filters.workspaceId); }
    if (filters.filter === 'fav') where.push('favorite=1');
    else if (filters.filter === 'text') where.push("mode='text'");
    else if (filters.filter === 'edit') where.push("mode='edit'");
    if (filters.query) {
      where.push('(prompt LIKE ? OR revisedPrompt LIKE ? OR workspaceTitle LIKE ?)');
      const like = '%' + filters.query + '%';
      values.push(like, like, like);
    }
    const whereSql = where.length ? ' WHERE ' + where.join(' AND ') : '';
    const total = db.prepare('SELECT COUNT(*) AS count FROM gallery' + whereSql).get(...values).count;
    const limit = Math.max(1, Math.min(300, Number(filters.limit) || 300));
    const offset = Math.max(0, Number(filters.offset) || 0);
    const rows = db.prepare('SELECT * FROM gallery' + whereSql + ' ORDER BY createdAt DESC LIMIT ? OFFSET ?')
      .all(...values, limit, offset).map(decorate);
    return { items: rows, total, limit, offset, hasMore: offset + rows.length < total };
  }

  async function createGallery(record, inputBuffer, inputMime) {
    let buffer = inputBuffer;
    let mime = normalizeMime(inputMime);
    if (!buffer && record.url) {
      const response = await fetch(record.url);
      if (!response.ok) throw new Error('Source image returned HTTP ' + response.status + '.');
      buffer = Buffer.from(await response.arrayBuffer());
      mime = normalizeMime(response.headers.get('content-type') || mime);
    }
    if (!buffer || !buffer.length) throw new Error('Generated image bytes are unavailable.');
    if (!SUPPORTED_MIMES.has(mime)) throw new Error('Unsupported generated image MIME: ' + (mime || 'unknown'));
    const detected = detectImageMime(buffer);
    if (detected !== mime) throw new BlockedMediaError('Generated image bytes do not match MIME ' + mime + '.');
    const metadata = await sharp(buffer, { failOn: 'error' }).metadata();
    if (!metadata.width || !metadata.height) throw new BlockedMediaError('Image dimensions are unavailable.');
    const thumbnail = await compressThumbnail(buffer);
    const createdAt = Number(record.createdAt) || now();
    const originalFilename = record.id + extensionForMime(mime);
    const thumbnailFilename = record.id + '.thumb.webp';
    const originalRelative = path.join('images', originalFilename);
    const thumbnailRelative = path.join('thumbnails', thumbnailFilename);
    const originalPath = safeLocalPath(dataDir, originalRelative);
    const thumbnailPath = safeLocalPath(dataDir, thumbnailRelative);
    if (!originalPath || !thumbnailPath) throw new Error('Invalid media path.');
    let originalWritten = false;
    let thumbnailWritten = false;
    try {
      await writeAtomic(originalPath, buffer);
      originalWritten = true;
      await writeAtomic(thumbnailPath, thumbnail.buffer);
      thumbnailWritten = true;
      db.prepare(`INSERT INTO gallery
        (id,workspaceId,workspaceTitle,prompt,revisedPrompt,model,size,mode,filename,url,sourceDataUrl,favorite,createdAt,mime,contentSha256,thumbnailFilename,thumbnailMime,thumbnailSha256,thumbnailByteSize)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?,?)`).run(
          record.id, record.workspaceId || '', record.workspaceTitle || '', record.prompt || '',
          record.revisedPrompt || '', record.model || '', record.size || '', record.mode || 'text',
          originalFilename, record.url || null, record.sourceDataUrl || null, createdAt,
          mime, sha256(buffer), thumbnailRelative, 'image/webp', sha256(thumbnail.buffer), thumbnail.byteSize,
        );
    } catch (error) {
      if (thumbnailWritten) await unlinkIfExists(thumbnailPath).catch(() => undefined);
      if (originalWritten) await unlinkIfExists(originalPath).catch(() => undefined);
      throw error;
    }
    return getGallery(record.id);
  }

  async function getContent(id) {
    const record = db.prepare('SELECT * FROM gallery WHERE id=?').get(id);
    if (!record || !record.filename) return null;
    const filePath = safeLocalPath(dataDir, path.join('images', path.basename(record.filename)));
    if (!filePath || !fs.existsSync(filePath)) return null;
    const buffer = await fs.promises.readFile(filePath);
    return { buffer, mime: normalizeMime(record.mime || mimeFromFilename(filePath) || 'image/png'), source: 'local' };
  }

  async function getThumbnail(id) {
    const record = db.prepare('SELECT * FROM gallery WHERE id=?').get(id);
    if (!record || !record.thumbnailFilename) return null;
    const filePath = safeLocalPath(dataDir, record.thumbnailFilename);
    if (!filePath || !fs.existsSync(filePath)) return null;
    return { buffer: await fs.promises.readFile(filePath), mime: 'image/webp', source: 'local' };
  }

  async function removeGalleryFiles(record) {
    const candidates = [
      record.filename && path.join('images', path.basename(record.filename)),
      record.thumbnailFilename,
    ].filter(Boolean);
    for (const relative of candidates) await unlinkIfExists(safeLocalPath(dataDir, relative));
  }

  async function deleteGallery(id) {
    const record = db.prepare('SELECT * FROM gallery WHERE id=?').get(id);
    if (!record) return { deleted: false };
    await removeGalleryFiles(record);
    db.prepare('DELETE FROM gallery WHERE id=?').run(id);
    return { deleted: true };
  }

  async function deleteExpired() {
    const expired = db.prepare(`SELECT * FROM gallery
      WHERE favorite=0 AND (createdAt IS NULL OR (createdAt + (? * 86400000)) <= ?)`).all(retentionDays(), now());
    let deleted = 0;
    const failures = [];
    for (const record of expired) {
      try {
        await removeGalleryFiles(record);
      } catch (error) {
        failures.push({ id: record.id, message: error.message });
        logger({ kind: 'media_expiry_error', galleryId: record.id, message: error.message });
        continue;
      }
      db.prepare('DELETE FROM gallery WHERE id=?').run(record.id);
      deleted += 1;
    }
    const expiredInputs = db.prepare(`SELECT * FROM inputs
      WHERE createdAt IS NULL OR (createdAt + (? * 86400000)) <= ?`).all(retentionDays(), now());
    for (const record of expiredInputs) {
      try {
        await unlinkIfExists(safeLocalPath(dataDir, path.join('inputs', path.basename(record.filename))));
      } catch (error) {
        failures.push({ id: record.id, message: error.message });
        logger({ kind: 'input_expiry_error', inputId: record.id, message: error.message });
        continue;
      }
      db.prepare('DELETE FROM inputs WHERE id=?').run(record.id);
      deleted += 1;
    }
    const errorText = failures.length ? failures.map((item) => item.message).join('; ') : null;
    db.prepare('UPDATE storage_settings SET lastCleanupAt=?,lastDeletedCount=?,lastError=? WHERE id=1')
      .run(now(), deleted, errorText);
    lastError = errorText;
    return { deleted, failures };
  }

  async function updateRetentionDays(value) {
    const days = Number(value);
    if (!Number.isInteger(days) || days < MIN_RETENTION_DAYS || days > MAX_RETENTION_DAYS) {
      const error = new Error('Retention days must be an integer between ' + MIN_RETENTION_DAYS + ' and ' + MAX_RETENTION_DAYS + '.');
      error.code = 'INVALID_RETENTION_DAYS';
      throw error;
    }
    db.prepare('UPDATE storage_settings SET retentionDays=?,updatedAt=? WHERE id=1').run(days, now());
    const result = await runCleanup();
    return {
      ...getStorageStatus(),
      deleted: Number(result.deleted || 0),
      failures: result.failures || [],
    };
  }

  function getStorageStatus() {
    const settings = settingsRow();
    return {
      retentionDays: Number(settings?.retentionDays || DEFAULT_RETENTION_DAYS),
      nextCleanupAt: nextCleanupAt || now(),
      lastCleanupAt: settings?.lastCleanupAt || null,
      lastDeletedCount: Number(settings?.lastDeletedCount || 0),
      galleryCount: db.prepare('SELECT COUNT(*) AS count FROM gallery').get().count,
      inputCount: db.prepare('SELECT COUNT(*) AS count FROM inputs').get().count,
      lastError: settings?.lastError || null,
    };
  }

  function schedule() {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    nextCleanupAt = now() + cleanupIntervalMs;
    timer = setTimeout(() => void runCleanup(), cleanupIntervalMs);
    if (timer.unref) timer.unref();
  }

  function runCleanup() {
    if (cleanupPromise) return cleanupPromise;
    cleanupPromise = (async () => {
      try {
        const result = await deleteExpired();
        lastError = null;
        return result;
      } catch (error) {
        lastError = error.message;
        logger({ kind: 'media_cleanup_error', message: error.message });
        db.prepare('UPDATE storage_settings SET lastError=? WHERE id=1').run(error.message);
        return { deleted: 0, failures: [], error: error.message };
      } finally {
        cleanupPromise = null;
        schedule();
      }
    })();
    return cleanupPromise;
  }

  function migrationApplied(name) {
    return Boolean(db.prepare('SELECT 1 FROM storage_migrations WHERE name=?').get(name));
  }

  function recordMigration(name) {
    db.prepare('INSERT OR IGNORE INTO storage_migrations (name,appliedAt) VALUES (?,?)').run(name, now());
  }

  async function removeLegacyPendingFiles() {
    const deleted = [];
    let entries = [];
    try { entries = await fs.promises.readdir(legacyPendingDir, { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT') return deleted; throw error; }
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const filePath = safeLocalPath(dataDir, path.join('pending-uploads', entry.name));
      if (!filePath) continue;
      try {
        await unlinkIfExists(filePath);
        deleted.push(entry.name);
      } catch (error) {
        logger({ kind: 'legacy_reset_file_error', filename: entry.name, message: error.message });
      }
    }
    return deleted;
  }

  async function migrateFromLegacy() {
    const result = { reset: false, deletedGallery: 0, deletedFiles: 0, deletedJobs: 0 };
    const hasJobs = Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='image_upload_jobs'").get());

    if (!migrationApplied('remit-reset-v1') && hasJobs) {
      const files = await removeLegacyPendingFiles();
      result.deletedFiles = files.length;
      result.deletedGallery = db.prepare('DELETE FROM gallery').run().changes;
      result.deletedJobs = db.prepare('DELETE FROM image_upload_jobs').run().changes;
      db.exec('DROP TABLE IF EXISTS image_upload_jobs');
      recordMigration('remit-reset-v1');
      result.reset = true;
    } else if (hasJobs) {
      result.deletedJobs = db.prepare('DELETE FROM image_upload_jobs').run().changes;
      db.exec('DROP TABLE IF EXISTS image_upload_jobs');
    }

    const columns = new Set(db.prepare('PRAGMA table_info(gallery)').all().map((row) => row.name));
    const missing = GALLERY_COLUMNS.filter((name) => !columns.has(name));
    const obsolete = columns.has('remoteUrl') || columns.has('uploadStatus') || columns.has('thumbnailStatus') || columns.has('uploadAttempts');
    if (obsolete || missing.length) {
      const rows = db.prepare('SELECT * FROM gallery').all();
      const localRows = rows.filter((row) => row.filename && (
        fs.existsSync(safeLocalPath(dataDir, path.join('images', path.basename(row.filename)))) ||
        fs.existsSync(safeLocalPath(dataDir, path.join('pending-uploads', path.basename(row.filename))))
      ));
      const migrate = db.transaction(() => {
        db.exec('DROP TABLE IF EXISTS gallery_new');
        db.exec(`CREATE TABLE gallery_new (
          id TEXT PRIMARY KEY, workspaceId TEXT, workspaceTitle TEXT, prompt TEXT,
          revisedPrompt TEXT, model TEXT, size TEXT, mode TEXT, filename TEXT, url TEXT,
          sourceDataUrl TEXT, favorite INTEGER DEFAULT 0, createdAt INTEGER, mime TEXT,
          contentSha256 TEXT, thumbnailFilename TEXT, thumbnailMime TEXT,
          thumbnailSha256 TEXT, thumbnailByteSize INTEGER
        )`);
        const newColumns = new Set(db.prepare('PRAGMA table_info(gallery_new)').all().map((column) => column.name));
        const insert = db.prepare(`INSERT INTO gallery_new
          (id,workspaceId,workspaceTitle,prompt,revisedPrompt,model,size,mode,filename,url,sourceDataUrl,favorite,createdAt,mime,contentSha256,thumbnailFilename,thumbnailMime,thumbnailSha256,thumbnailByteSize)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        for (const row of localRows) {
          const pendingOriginal = safeLocalPath(dataDir, path.join('pending-uploads', path.basename(row.filename)));
          const existingOriginal = safeLocalPath(dataDir, path.join('images', path.basename(row.filename)));
          const sourcePath = fs.existsSync(existingOriginal) ? existingOriginal : pendingOriginal;
          const originalFilename = path.basename(row.filename);
          const destinationPath = safeLocalPath(dataDir, path.join('images', originalFilename));
          if (sourcePath !== destinationPath && fs.existsSync(sourcePath)) {
            fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
            fs.renameSync(sourcePath, destinationPath);
            result.deletedFiles += 1;
          }
          let thumbnailFilename = null;
          const oldThumb = safeLocalPath(dataDir, path.join('pending-uploads', row.id + '.thumb.webp'));
          if (fs.existsSync(oldThumb)) {
            const target = safeLocalPath(dataDir, path.join('thumbnails', row.id + '.thumb.webp'));
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.renameSync(oldThumb, target);
            thumbnailFilename = path.join('thumbnails', row.id + '.thumb.webp');
            result.deletedFiles += 1;
          }
          const mime = normalizeMime(row.mime || mimeFromFilename(originalFilename));
          const thumbPath = thumbnailFilename && safeLocalPath(dataDir, thumbnailFilename);
          insert.run(
            row.id, row.workspaceId || '', row.workspaceTitle || '', row.prompt || '', row.revisedPrompt || '',
            row.model || '', row.size || '', row.mode || 'text', originalFilename, row.url || null,
            row.sourceDataUrl || null, row.favorite ? 1 : 0, row.createdAt || now(), mime,
            sha256(fs.readFileSync(destinationPath)),
            thumbnailFilename, thumbnailFilename ? 'image/webp' : null,
            thumbPath ? sha256(fs.readFileSync(thumbPath)) : null,
            thumbPath ? fs.statSync(thumbPath).size : null,
          );
        }
        db.exec('DROP TABLE gallery');
        db.exec('ALTER TABLE gallery_new RENAME TO gallery');
        db.exec(`CREATE INDEX IF NOT EXISTS idx_gallery_workspace ON gallery(workspaceId);
          CREATE INDEX IF NOT EXISTS idx_gallery_created ON gallery(createdAt);
          CREATE INDEX IF NOT EXISTS idx_gallery_favorite ON gallery(favorite);`);
      });
      migrate();
      result.deletedGallery += result.reset ? 0 : Math.max(0, rows.length - localRows.length);
      recordMigration('gallery-local-v1');
    }
    return result;
  }

  async function start() {
    stopped = false;
    const migration = await migrateFromLegacy();
    await runCleanup();
    return { migration };
  }

  function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return {
    start, stop, runCleanup, deleteExpired, deleteGallery, createGallery, getGallery,
    listGallery, getContent, getThumbnail, getStorageStatus, updateRetentionDays,
    retentionDays, expiresAt, nextCleanupAt: () => nextCleanupAt,
    get lastError() { return lastError; },
  };
}

module.exports = {
  CLEANUP_INTERVAL_MS, DEFAULT_RETENTION_DAYS, MAX_RETENTION_DAYS, MIN_RETENTION_DAYS,
  THUMBNAIL_MAX_BYTES, BlockedMediaError, compressThumbnail, createLocalMediaManager,
  createSchema, detectImageMime, extensionForMime, mimeFromFilename, normalizeMime,
  safeLocalPath, sha256, writeAtomic,
};
