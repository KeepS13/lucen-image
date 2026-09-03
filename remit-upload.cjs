const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");

const REMIT_ORIGIN = "https://img.remit.ee";
const REMIT_UPLOAD_URL = REMIT_ORIGIN + "/api/upload";
const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;
const TARGET_UPLOAD_BYTES = 19 * 1024 * 1024;
const DEFAULT_RETRY_MS = 5 * 60 * 1000;
const DEFAULT_PACE_MS = 12 * 1000;
const UPLOAD_TIMEOUT_MS = 5 * 60 * 1000;
const THUMBNAIL_MAX_BYTES = 100000;
const THUMBNAIL_MAX_EDGE = 640;
const THUMBNAIL_MIN_SHORT_EDGE = 256;
const SUPPORTED_MIMES = new Set(["image/jpeg", "image/png", "image/webp"]);
const MIME_EXTENSIONS = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

class BlockedUploadError extends Error {
  constructor(message) {
    super(message);
    this.name = "BlockedUploadError";
  }
}

class RetryUploadError extends Error {
  constructor(message, retryAfterMs = 0, discardRemote = false) {
    super(message);
    this.name = "RetryUploadError";
    this.retryAfterMs = retryAfterMs;
    this.discardRemote = discardRemote;
  }
}

function normalizeMime(value) {
  const mime = String(value || "").split(";", 1)[0].trim().toLowerCase();
  return mime === "image/jpg" ? "image/jpeg" : mime;
}

function mimeFromFilename(filename) {
  const extension = path.extname(String(filename || "")).toLowerCase();
  if (extension === ".jpg" || extension === ".jpeg") return "image/jpeg";
  if (extension === ".png") return "image/png";
  if (extension === ".webp") return "image/webp";
  return "";
}

function extensionForMime(mime) {
  return MIME_EXTENSIONS[normalizeMime(mime)] || "";
}

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function detectImageMime(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 12) return "";
  if (buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP") return "image/webp";
  return "";
}

function isValidRemitUrl(raw) {
  try {
    const parsed = new URL(raw);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "img.remit.ee" &&
      parsed.port === "" &&
      parsed.pathname.startsWith("/api/file/")
    );
  } catch (_) {
    return false;
  }
}

function parseRetryAfter(value, now = Date.now()) {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1000;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? Math.max(0, timestamp - now) : 0;
}

async function encodeImage(input, mime, quality, width) {
  let pipeline = sharp(input, { failOn: "error" }).rotate();
  if (width) pipeline = pipeline.resize({ width, withoutEnlargement: true });
  if (mime === "image/jpeg") {
    pipeline = pipeline.jpeg({ quality, mozjpeg: true });
  } else if (mime === "image/webp") {
    pipeline = pipeline.webp({ quality, effort: 5 });
  } else if (mime === "image/png") {
    pipeline = pipeline.png({
      compressionLevel: 9,
      adaptiveFiltering: true,
      palette: quality < 100,
      quality,
      effort: 10,
    });
  }
  return pipeline.toBuffer({ resolveWithObject: true });
}

async function compressToLimit(buffer, mime, options = {}) {
  const targetBytes = options.targetBytes || TARGET_UPLOAD_BYTES;
  const minimumShortEdge = options.minimumShortEdge || 512;
  const normalizedMime = normalizeMime(mime);
  if (!SUPPORTED_MIMES.has(normalizedMime)) {
    throw new BlockedUploadError("Unsupported image MIME: " + (normalizedMime || "unknown"));
  }

  const metadata = await sharp(buffer, { failOn: "error" }).metadata();
  const originalWidth = metadata.width || 0;
  const originalHeight = metadata.height || 0;
  if (!originalWidth || !originalHeight) throw new BlockedUploadError("Image dimensions are unavailable.");
  if (buffer.length <= targetBytes) {
    return {
      buffer,
      mime: normalizedMime,
      originalByteSize: buffer.length,
      byteSize: buffer.length,
      originalWidth,
      originalHeight,
      width: originalWidth,
      height: originalHeight,
      compressed: false,
    };
  }

  const qualities = normalizedMime === "image/png" ? [100, 90, 80, 70, 60] : [90, 80, 70, 60, 50, 45];
  let width = originalWidth;
  let best = null;
  while (true) {
    for (const quality of qualities) {
      const encoded = await encodeImage(buffer, normalizedMime, quality, width);
      if (!best || encoded.data.length < best.data.length) best = encoded;
      if (encoded.data.length <= targetBytes) {
        return {
          buffer: encoded.data,
          mime: normalizedMime,
          originalByteSize: buffer.length,
          byteSize: encoded.data.length,
          originalWidth,
          originalHeight,
          width: encoded.info.width,
          height: encoded.info.height,
          compressed: true,
        };
      }
    }

    const bestWidth = best && best.info.width ? best.info.width : width;
    const bestHeight = best && best.info.height ? best.info.height : Math.round((originalHeight / originalWidth) * width);
    if (Math.min(bestWidth, bestHeight) <= minimumShortEdge) break;
    width = Math.max(1, Math.floor(width * 0.9));
  }

  throw new BlockedUploadError(
    "Image cannot be compressed below " + Math.round(targetBytes / 1024 / 1024) + " MiB without changing format.",
  );
}

async function compressThumbnail(buffer, options = {}) {
  const maxBytes = options.maxBytes || THUMBNAIL_MAX_BYTES;
  const maxEdge = options.maxEdge || THUMBNAIL_MAX_EDGE;
  const minimumShortEdge = options.minimumShortEdge || THUMBNAIL_MIN_SHORT_EDGE;
  const metadata = await sharp(buffer, { failOn: "error" }).metadata();
  const originalWidth = metadata.width || 0;
  const originalHeight = metadata.height || 0;
  if (!originalWidth || !originalHeight) throw new BlockedUploadError("Image dimensions are unavailable.");

  const qualities = [82, 72, 62, 52, 42, 32, 24, 18];
  let width = Math.min(maxEdge, originalWidth);
  let best = null;
  while (true) {
    for (const quality of qualities) {
      const encoded = await sharp(buffer, { failOn: "error" })
        .rotate()
        .resize({ width, withoutEnlargement: true })
        .webp({ quality, effort: 6 })
        .toBuffer({ resolveWithObject: true });
      if (!best || encoded.data.length < best.data.length) best = encoded;
      if (encoded.data.length < maxBytes) {
        return {
          buffer: encoded.data,
          mime: "image/webp",
          originalByteSize: buffer.length,
          byteSize: encoded.data.length,
          originalWidth,
          originalHeight,
          width: encoded.info.width,
          height: encoded.info.height,
          blocked: false,
        };
      }
    }

    const bestWidth = best && best.info.width ? best.info.width : width;
    const bestHeight = best && best.info.height ? best.info.height : Math.round((originalHeight / originalWidth) * width);
    if (Math.min(bestWidth, bestHeight) <= minimumShortEdge) break;
    width = Math.max(1, Math.floor(width * 0.85));
  }

  return {
    buffer: best ? best.data : Buffer.alloc(0),
    mime: "image/webp",
    originalByteSize: buffer.length,
    byteSize: best ? best.data.length : 0,
    originalWidth,
    originalHeight,
    width: best && best.info.width ? best.info.width : width,
    height: best && best.info.height ? best.info.height : Math.round((originalHeight / originalWidth) * width),
    blocked: true,
    error: "Image cannot be compressed below 100000 bytes as WebP.",
  };
}

function ensureGalleryColumns(db) {
  const columns = new Set(db.prepare("PRAGMA table_info(gallery)").all().map((column) => column.name));
  const additions = [
    ["remoteUrl", "TEXT"],
    ["mime", "TEXT"],
    ["contentSha256", "TEXT"],
    ["uploadStatus", "TEXT"],
    ["uploadAttempts", "INTEGER DEFAULT 0"],
    ["nextRetryAt", "INTEGER"],
    ["lastUploadError", "TEXT"],
    ["uploadedAt", "INTEGER"],
    ["thumbnailUrl", "TEXT"],
    ["thumbnailMime", "TEXT"],
    ["thumbnailSha256", "TEXT"],
    ["thumbnailStatus", "TEXT"],
    ["thumbnailAttempts", "INTEGER DEFAULT 0"],
    ["thumbnailNextRetryAt", "INTEGER"],
    ["thumbnailLastUploadError", "TEXT"],
    ["thumbnailUploadedAt", "INTEGER"],
    ["thumbnailByteSize", "INTEGER"],
  ];
  for (const [name, definition] of additions) {
    if (!columns.has(name)) db.exec("ALTER TABLE gallery ADD COLUMN " + name + " " + definition);
  }
}

function ensureJobColumns(db) {
  const columns = new Set(db.prepare("PRAGMA table_info(image_upload_jobs)").all().map((column) => column.name));
  const additions = [
    ["thumbnailStatus", "TEXT"],
    ["thumbnailAttempts", "INTEGER DEFAULT 0"],
    ["thumbnailNextRetryAt", "INTEGER"],
    ["thumbnailLastError", "TEXT"],
    ["thumbnailFilename", "TEXT"],
    ["thumbnailMime", "TEXT"],
    ["thumbnailSha256", "TEXT"],
    ["thumbnailByteSize", "INTEGER"],
    ["thumbnailOriginalByteSize", "INTEGER"],
    ["thumbnailOriginalWidth", "INTEGER"],
    ["thumbnailOriginalHeight", "INTEGER"],
    ["thumbnailWidth", "INTEGER"],
    ["thumbnailHeight", "INTEGER"],
    ["thumbnailRemoteUrl", "TEXT"],
    ["thumbnailUploadedAt", "INTEGER"],
  ];
  for (const [name, definition] of additions) {
    if (!columns.has(name)) db.exec("ALTER TABLE image_upload_jobs ADD COLUMN " + name + " " + definition);
  }
}

function ensureJobVariantSchema(db) {
  const columns = db.prepare("PRAGMA table_info(image_upload_jobs)").all();
  const variantColumn = columns.find((column) => column.name === "variant");
  const galleryColumn = columns.find((column) => column.name === "galleryId");
  if (variantColumn && galleryColumn && galleryColumn.pk === 1 && variantColumn.pk === 2) return;

  const table = `
    CREATE TABLE image_upload_jobs_new (
      galleryId TEXT NOT NULL,
      variant TEXT NOT NULL DEFAULT 'original',
      kind TEXT NOT NULL DEFAULT 'new',
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      nextRetryAt INTEGER,
      lastError TEXT,
      localFilename TEXT,
      mime TEXT,
      sha256 TEXT,
      byteSize INTEGER,
      originalByteSize INTEGER,
      originalWidth INTEGER,
      originalHeight INTEGER,
      width INTEGER,
      height INTEGER,
      remoteUrl TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      lockedAt INTEGER,
      thumbnailStatus TEXT,
      thumbnailAttempts INTEGER DEFAULT 0,
      thumbnailNextRetryAt INTEGER,
      thumbnailLastError TEXT,
      thumbnailFilename TEXT,
      thumbnailMime TEXT,
      thumbnailSha256 TEXT,
      thumbnailByteSize INTEGER,
      thumbnailOriginalByteSize INTEGER,
      thumbnailOriginalWidth INTEGER,
      thumbnailOriginalHeight INTEGER,
      thumbnailWidth INTEGER,
      thumbnailHeight INTEGER,
      thumbnailRemoteUrl TEXT,
      thumbnailUploadedAt INTEGER,
      PRIMARY KEY (galleryId, variant)
    );
  `;
  const columnsToCopy = [
    "galleryId", "kind", "status", "attempts", "nextRetryAt", "lastError", "localFilename", "mime", "sha256", "byteSize",
    "originalByteSize", "originalWidth", "originalHeight", "width", "height", "remoteUrl", "createdAt", "updatedAt", "lockedAt",
    "thumbnailStatus", "thumbnailAttempts", "thumbnailNextRetryAt", "thumbnailLastError", "thumbnailFilename", "thumbnailMime",
    "thumbnailSha256", "thumbnailByteSize", "thumbnailOriginalByteSize", "thumbnailOriginalWidth", "thumbnailOriginalHeight",
    "thumbnailWidth", "thumbnailHeight", "thumbnailRemoteUrl", "thumbnailUploadedAt",
  ];
  db.exec("DROP INDEX IF EXISTS idx_image_upload_jobs_due");
  db.exec("ALTER TABLE image_upload_jobs RENAME TO image_upload_jobs_old");
  db.exec(table);
  const sourceVariant = variantColumn ? "COALESCE(variant, 'original')" : "'original'";
  db.exec(
    `INSERT INTO image_upload_jobs_new (variant,${columnsToCopy.join(",")})
     SELECT ${sourceVariant},${columnsToCopy.join(",")} FROM image_upload_jobs_old`,
  );
  db.exec("DROP TABLE image_upload_jobs_old");
  db.exec("ALTER TABLE image_upload_jobs_new RENAME TO image_upload_jobs");
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_image_upload_jobs_due
      ON image_upload_jobs(variant,status,nextRetryAt,createdAt);
    CREATE UNIQUE INDEX IF NOT EXISTS uq_image_upload_jobs_gallery_variant
      ON image_upload_jobs(galleryId,variant);
  `);
}

function createSchema(db) {
  ensureGalleryColumns(db);
  db.exec(`
    CREATE TABLE IF NOT EXISTS image_upload_jobs (
      galleryId TEXT NOT NULL,
      variant TEXT NOT NULL DEFAULT 'original',
      kind TEXT NOT NULL DEFAULT 'new',
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      nextRetryAt INTEGER,
      lastError TEXT,
      localFilename TEXT,
      mime TEXT,
      sha256 TEXT,
      byteSize INTEGER,
      originalByteSize INTEGER,
      originalWidth INTEGER,
      originalHeight INTEGER,
      width INTEGER,
      height INTEGER,
      remoteUrl TEXT,
      createdAt INTEGER NOT NULL,
      updatedAt INTEGER NOT NULL,
      lockedAt INTEGER,
      thumbnailStatus TEXT,
      thumbnailAttempts INTEGER DEFAULT 0,
      thumbnailNextRetryAt INTEGER,
      thumbnailLastError TEXT,
      thumbnailFilename TEXT,
      thumbnailMime TEXT,
      thumbnailSha256 TEXT,
      thumbnailByteSize INTEGER,
      thumbnailOriginalByteSize INTEGER,
      thumbnailOriginalWidth INTEGER,
      thumbnailOriginalHeight INTEGER,
      thumbnailWidth INTEGER,
      thumbnailHeight INTEGER,
      thumbnailRemoteUrl TEXT,
      thumbnailUploadedAt INTEGER,
      PRIMARY KEY (galleryId,variant)
    );
    CREATE INDEX IF NOT EXISTS idx_image_upload_jobs_due
      ON image_upload_jobs(variant,status, nextRetryAt, createdAt);
  `);
  ensureJobColumns(db);
  ensureJobVariantSchema(db);
}

function safeLocalPath(dataDir, relativePath) {
  if (!relativePath) return "";
  const root = path.resolve(dataDir) + path.sep;
  const resolved = path.resolve(dataDir, relativePath);
  return resolved.startsWith(root) ? resolved : "";
}

async function writeAtomic(filePath, buffer) {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  const partial = filePath + ".part-" + process.pid + "-" + Date.now();
  await fs.promises.writeFile(partial, buffer);
  await fs.promises.rename(partial, filePath);
}

function errorMessage(error) {
  return error && error.message ? error.message : String(error);
}

function createRemitUploadManager(options) {
  const db = options.db;
  const dataDir = options.dataDir;
  const fetchImpl = options.fetchImpl || fetch;
  const now = options.now || Date.now;
  const uploadUrl = options.uploadUrl || REMIT_UPLOAD_URL;
  const retryMs = options.retryMs || DEFAULT_RETRY_MS;
  const paceMs = options.paceMs === undefined ? DEFAULT_PACE_MS : options.paceMs;
  const targetBytes = options.targetBytes || TARGET_UPLOAD_BYTES;
  const logger = options.logger || (() => undefined);
  const uploadsEnabled = options.uploadsEnabled !== false;
  const pendingDir = path.join(dataDir, "pending-uploads");
  let running = false;
  let stopped = false;
  let timer = null;
  let timerAt = 0;
  let lastError = "";
  const activeControllers = new Set();

  createSchema(db);
  fs.mkdirSync(pendingDir, { recursive: true });

  const updateStatus = db.transaction((galleryId, status, fields = {}) => {
    const timestamp = now();
    const assignments = ["status = ?", "updatedAt = ?"];
    const values = [status, timestamp];
    for (const [name, value] of Object.entries(fields.job || {})) {
      assignments.push(name + " = ?");
      values.push(value);
    }
    values.push(galleryId);
    db.prepare("UPDATE image_upload_jobs SET " + assignments.join(", ") + " WHERE galleryId = ? AND variant = 'original'").run(...values);

    const galleryFields = {
      uploadStatus: status,
      uploadAttempts: fields.attempts,
      nextRetryAt: fields.nextRetryAt,
      lastUploadError: fields.lastError,
      ...(fields.gallery || {}),
    };
    const galleryAssignments = [];
    const galleryValues = [];
    for (const [name, value] of Object.entries(galleryFields)) {
      if (value === undefined) continue;
      galleryAssignments.push(name + " = ?");
      galleryValues.push(value);
    }
    if (galleryAssignments.length) {
      galleryValues.push(galleryId);
      db.prepare("UPDATE gallery SET " + galleryAssignments.join(", ") + " WHERE id = ?").run(...galleryValues);
    }
  });

  function syncThumbnailRow(galleryId) {
    db.prepare(
      `INSERT OR IGNORE INTO image_upload_jobs
       (galleryId,variant,kind,status,attempts,nextRetryAt,lastError,localFilename,mime,sha256,byteSize,createdAt,updatedAt)
       SELECT galleryId,'thumbnail',kind,COALESCE(thumbnailStatus,'pending'),COALESCE(thumbnailAttempts,0),thumbnailNextRetryAt,thumbnailLastError,thumbnailFilename,thumbnailMime,thumbnailSha256,thumbnailByteSize,createdAt,updatedAt
       FROM image_upload_jobs WHERE galleryId=? AND variant='original'`,
    ).run(galleryId);
    db.prepare(
      `UPDATE image_upload_jobs AS thumb
       SET status=(SELECT thumbnailStatus FROM image_upload_jobs WHERE galleryId=? AND variant='original'),
           attempts=(SELECT COALESCE(thumbnailAttempts,0) FROM image_upload_jobs WHERE galleryId=? AND variant='original'),
           nextRetryAt=(SELECT thumbnailNextRetryAt FROM image_upload_jobs WHERE galleryId=? AND variant='original'),
           lastError=(SELECT thumbnailLastError FROM image_upload_jobs WHERE galleryId=? AND variant='original'),
           localFilename=(SELECT thumbnailFilename FROM image_upload_jobs WHERE galleryId=? AND variant='original'),
           mime=(SELECT thumbnailMime FROM image_upload_jobs WHERE galleryId=? AND variant='original'),
           sha256=(SELECT thumbnailSha256 FROM image_upload_jobs WHERE galleryId=? AND variant='original'),
           byteSize=(SELECT thumbnailByteSize FROM image_upload_jobs WHERE galleryId=? AND variant='original'),
           remoteUrl=(SELECT thumbnailRemoteUrl FROM image_upload_jobs WHERE galleryId=? AND variant='original'),
           updatedAt=(SELECT updatedAt FROM image_upload_jobs WHERE galleryId=? AND variant='original')
       WHERE thumb.galleryId=? AND thumb.variant='thumbnail'`,
    ).run(galleryId, galleryId, galleryId, galleryId, galleryId, galleryId, galleryId, galleryId, galleryId, galleryId, galleryId);
  }

  const updateThumbnailStatus = db.transaction((galleryId, status, fields = {}) => {
    const timestamp = now();
    const jobAssignments = ["thumbnailStatus = ?", "updatedAt = ?"];
    const jobValues = [status, timestamp];
    for (const [name, value] of Object.entries(fields.job || {})) {
      jobAssignments.push(name + " = ?");
      jobValues.push(value);
    }
    jobValues.push(galleryId);
    db.prepare("UPDATE image_upload_jobs SET " + jobAssignments.join(", ") + " WHERE galleryId = ? AND variant = 'original'").run(...jobValues);

    syncThumbnailRow(galleryId);

    const galleryFields = {
      thumbnailStatus: status,
      thumbnailAttempts: fields.attempts,
      thumbnailNextRetryAt: fields.nextRetryAt,
      thumbnailLastUploadError: fields.lastError,
      ...(fields.gallery || {}),
    };
    const galleryAssignments = [];
    const galleryValues = [];
    for (const [name, value] of Object.entries(galleryFields)) {
      if (value === undefined) continue;
      galleryAssignments.push(name + " = ?");
      galleryValues.push(value);
    }
    if (galleryAssignments.length) {
      galleryValues.push(galleryId);
      db.prepare("UPDATE gallery SET " + galleryAssignments.join(", ") + " WHERE id = ?").run(...galleryValues);
    }
  });

  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
    timerAt = 0;
  }

  function schedule(delay = 0) {
    if (stopped || !uploadsEnabled) return;
    const dueAt = now() + Math.max(0, delay);
    if (timer && timerAt <= dueAt) return;
    clearTimer();
    timerAt = dueAt;
    timer = setTimeout(() => {
      timer = null;
      timerAt = 0;
      void runNext();
    }, Math.max(0, delay));
  }

  async function fetchWithTimeout(url, init = {}) {
    const controller = new AbortController();
    activeControllers.add(controller);
    const timeout = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
    try {
      return await fetchImpl(url, { ...init, signal: controller.signal });
    } finally {
      clearTimeout(timeout);
      activeControllers.delete(controller);
    }
  }

  function nextTask() {
    const timestamp = now();
    const job = db
      .prepare(
        `SELECT *, 'original' AS variant FROM image_upload_jobs
         WHERE variant='original' AND status IN ('pending', 'retry_wait') AND COALESCE(nextRetryAt, 0) <= ?
         ORDER BY createdAt ASC LIMIT 1`,
      )
      .get(timestamp);
    const thumbnail = db
      .prepare(
        `SELECT *, 'thumbnail' AS variant FROM image_upload_jobs
         WHERE variant='original' AND thumbnailStatus IN ('pending', 'retry_wait') AND COALESCE(thumbnailNextRetryAt, 0) <= ?
         ORDER BY createdAt ASC LIMIT 1`,
      )
      .get(timestamp);
    if (!job) return thumbnail;
    if (!thumbnail) return job;
    return thumbnail.createdAt < job.createdAt ? thumbnail : job;
  }

  function scheduleNextDue() {
    const row = db.prepare(
      `SELECT MIN(nextAt) AS nextAt FROM (
         SELECT MIN(nextRetryAt) AS nextAt FROM image_upload_jobs WHERE variant='original' AND status IN ('pending', 'retry_wait')
         UNION ALL
         SELECT MIN(thumbnailNextRetryAt) AS nextAt FROM image_upload_jobs WHERE variant='original' AND thumbnailStatus IN ('pending', 'retry_wait')
       ) WHERE nextAt IS NOT NULL`,
    ).get();
    if (row && row.nextAt !== null) schedule(Math.max(0, row.nextAt - now()));
  }

  async function verifyRemote(remoteUrl, expected) {
    const response = await fetchWithTimeout(remoteUrl, {
      method: "GET",
      redirect: "manual",
      headers: { Accept: expected.mime },
    });
    if (!response.ok) throw new RetryUploadError("Remote verification returned HTTP " + response.status + ".");
    if (!isValidRemitUrl(response.url || remoteUrl)) throw new RetryUploadError("Remote verification left the Remit host.");
    const remote = Buffer.from(await response.arrayBuffer());
    const responseMime = normalizeMime(response.headers.get("content-type"));
    const detectedMime = detectImageMime(remote);
    if (responseMime && responseMime !== "application/octet-stream" && responseMime !== "binary/octet-stream" && responseMime !== expected.mime) {
      throw new RetryUploadError("Remote MIME mismatch: " + responseMime + ".", 0, true);
    }
    if (detectedMime !== expected.mime) {
      throw new RetryUploadError("Remote image bytes do not match the expected MIME.", 0, true);
    }
    if (remote.length !== expected.byteSize) throw new RetryUploadError("Remote byte length does not match the upload.", 0, true);
    if (sha256(remote) !== expected.sha256) throw new RetryUploadError("Remote SHA-256 does not match the upload.", 0, true);
  }

  async function uploadJob(job) {
    const localPath = safeLocalPath(dataDir, job.localFilename);
    if (!localPath || !fs.existsSync(localPath)) throw new BlockedUploadError("The temporary image file is missing.");
    const original = await fs.promises.readFile(localPath);
    const mime = normalizeMime(job.mime || mimeFromFilename(localPath));
    const compressed = await compressToLimit(original, mime, { targetBytes });
    const uploadBuffer = compressed.buffer;
    if (uploadBuffer.length > MAX_UPLOAD_BYTES) {
      throw new BlockedUploadError("The compressed image still exceeds the Remit 20 MiB limit.");
    }
    if (compressed.compressed || sha256(uploadBuffer) !== job.sha256) await writeAtomic(localPath, uploadBuffer);
    const digest = sha256(uploadBuffer);
    db.prepare(
      `UPDATE image_upload_jobs SET mime=?,sha256=?,byteSize=?,originalByteSize=?,originalWidth=?,originalHeight=?,width=?,height=?,updatedAt=?
       WHERE galleryId=? AND variant='original'`,
    ).run(
      mime,
      digest,
      uploadBuffer.length,
      job.originalByteSize || compressed.originalByteSize,
      compressed.originalWidth,
      compressed.originalHeight,
      compressed.width,
      compressed.height,
      now(),
      job.galleryId,
    );

    if (isValidRemitUrl(job.remoteUrl)) {
      await verifyRemote(job.remoteUrl, { mime, byteSize: uploadBuffer.length, sha256: digest });
      return { remoteUrl: job.remoteUrl, mime, digest, localPath, compressed };
    }

    const form = new FormData();
    form.append("file", new Blob([uploadBuffer], { type: mime }), path.basename(localPath));
    const response = await fetchWithTimeout(uploadUrl, {
      method: "POST",
      headers: { Accept: "application/json", Referer: REMIT_ORIGIN + "/" },
      body: form,
    });
    if (!response.ok) {
      throw new RetryUploadError(
        "Remit upload returned HTTP " + response.status + ".",
        parseRetryAfter(response.headers.get("retry-after"), now()),
      );
    }
    let payload;
    try {
      payload = await response.json();
    } catch (_) {
      throw new RetryUploadError("Remit upload returned invalid JSON.");
    }
    const rawUrl = payload && (payload.directUrl || payload.url || payload.previewUrl);
    const remoteUrl = rawUrl ? new URL(rawUrl, REMIT_ORIGIN).toString() : "";
    if (!payload || payload.success !== true || !isValidRemitUrl(remoteUrl)) {
      throw new RetryUploadError("Remit upload did not return a valid direct URL.");
    }
    db.prepare("UPDATE image_upload_jobs SET remoteUrl=?,updatedAt=? WHERE galleryId=? AND variant='original'").run(remoteUrl, now(), job.galleryId);
    await verifyRemote(remoteUrl, { mime, byteSize: uploadBuffer.length, sha256: digest });
    return { remoteUrl, mime, digest, localPath, compressed };
  }

  async function loadThumbnailSource(job, gallery) {
    const localCandidates = [
      job.localFilename,
      gallery && gallery.filename && path.join("images", path.basename(gallery.filename)),
      gallery && gallery.filename && path.join("pending-uploads", path.basename(gallery.filename)),
    ].filter(Boolean);
    for (const relative of localCandidates) {
      const localPath = safeLocalPath(dataDir, relative);
      if (localPath && fs.existsSync(localPath)) return fs.promises.readFile(localPath);
    }
    if (!gallery || !isValidRemitUrl(gallery.remoteUrl)) {
      throw new BlockedUploadError("The original image is unavailable for thumbnail generation.");
    }
    const response = await fetchWithTimeout(gallery.remoteUrl, { redirect: "manual", headers: { Accept: gallery.mime || "image/*" } });
    if (!response.ok || !isValidRemitUrl(response.url || gallery.remoteUrl)) {
      throw new RetryUploadError("Original image download returned HTTP " + response.status + ".");
    }
    const source = Buffer.from(await response.arrayBuffer());
    if (gallery.contentSha256 && sha256(source) !== gallery.contentSha256) {
      throw new RetryUploadError("Original image SHA-256 does not match the gallery record.");
    }
    return source;
  }

  async function uploadThumbnailJob(job) {
    const gallery = db.prepare("SELECT * FROM gallery WHERE id = ?").get(job.galleryId);
    if (!gallery) throw new BlockedUploadError("The gallery record is missing.");
    let thumbnailPath = safeLocalPath(dataDir, job.thumbnailFilename);
    let thumbnail;
    if (thumbnailPath && fs.existsSync(thumbnailPath)) {
      thumbnail = {
        buffer: await fs.promises.readFile(thumbnailPath),
        mime: "image/webp",
        byteSize: job.thumbnailByteSize,
        originalByteSize: job.thumbnailOriginalByteSize,
        originalWidth: job.thumbnailOriginalWidth,
        originalHeight: job.thumbnailOriginalHeight,
        width: job.thumbnailWidth,
        height: job.thumbnailHeight,
        blocked: false,
      };
    } else {
      const source = await loadThumbnailSource(job, gallery);
      thumbnail = await compressThumbnail(source, { maxBytes: THUMBNAIL_MAX_BYTES });
      const filename = job.galleryId + ".thumb.webp";
      const relative = path.join("pending-uploads", filename);
      thumbnailPath = safeLocalPath(dataDir, relative);
      await writeAtomic(thumbnailPath, thumbnail.buffer);
      db.prepare(
        `UPDATE image_upload_jobs SET thumbnailFilename=?,thumbnailMime=?,thumbnailSha256=?,thumbnailByteSize=?,thumbnailOriginalByteSize=?,thumbnailOriginalWidth=?,thumbnailOriginalHeight=?,thumbnailWidth=?,thumbnailHeight=?,updatedAt=? WHERE galleryId=? AND variant='original'`,
      ).run(relative, thumbnail.mime, sha256(thumbnail.buffer), thumbnail.byteSize, thumbnail.originalByteSize, thumbnail.originalWidth, thumbnail.originalHeight, thumbnail.width, thumbnail.height, now(), job.galleryId);
      db.prepare(
        `UPDATE gallery SET thumbnailMime=?,thumbnailSha256=?,thumbnailByteSize=? WHERE id=?`,
      ).run(thumbnail.mime, sha256(thumbnail.buffer), thumbnail.byteSize, job.galleryId);
    }
    if (!thumbnail.buffer.length) throw new BlockedUploadError("Thumbnail generation returned empty bytes.");
    if (thumbnail.buffer.length >= THUMBNAIL_MAX_BYTES) {
      throw new BlockedUploadError("Thumbnail cannot be compressed below 100000 bytes as WebP.");
    }
    const digest = sha256(thumbnail.buffer);
    const mime = "image/webp";
    db.prepare(
      `UPDATE image_upload_jobs SET thumbnailMime=?,thumbnailSha256=?,thumbnailByteSize=?,updatedAt=? WHERE galleryId=? AND variant='original'`,
    ).run(mime, digest, thumbnail.buffer.length, now(), job.galleryId);

    let remoteUrl = job.thumbnailRemoteUrl;
    if (isValidRemitUrl(remoteUrl)) {
      await verifyRemote(remoteUrl, { mime, byteSize: thumbnail.buffer.length, sha256: digest });
    } else {
      const form = new FormData();
      form.append("file", new Blob([thumbnail.buffer], { type: mime }), path.basename(thumbnailPath || job.galleryId + ".thumb.webp"));
      const response = await fetchWithTimeout(uploadUrl, {
        method: "POST",
        headers: { Accept: "application/json", Referer: REMIT_ORIGIN + "/" },
        body: form,
      });
      if (!response.ok) {
        throw new RetryUploadError(
          "Remit thumbnail upload returned HTTP " + response.status + ".",
          parseRetryAfter(response.headers.get("retry-after"), now()),
        );
      }
      let payload;
      try {
        payload = await response.json();
      } catch (_) {
        throw new RetryUploadError("Remit thumbnail upload returned invalid JSON.");
      }
      const rawUrl = payload && (payload.directUrl || payload.url || payload.previewUrl);
      remoteUrl = rawUrl ? new URL(rawUrl, REMIT_ORIGIN).toString() : "";
      if (!payload || payload.success !== true || !isValidRemitUrl(remoteUrl)) {
        throw new RetryUploadError("Remit thumbnail upload did not return a valid direct URL.");
      }
      db.prepare("UPDATE image_upload_jobs SET thumbnailRemoteUrl=?,updatedAt=? WHERE galleryId=? AND variant='original'").run(remoteUrl, now(), job.galleryId);
      await verifyRemote(remoteUrl, { mime, byteSize: thumbnail.buffer.length, sha256: digest });
    }
    return { remoteUrl, mime, digest, thumbnailPath, thumbnail };
  }

  async function processOriginalJob(job) {
    const attempts = Number(job.attempts || 0) + 1;
    updateStatus(job.galleryId, "uploading", {
      attempts,
      nextRetryAt: null,
      lastError: null,
      job: { attempts, nextRetryAt: null, lastError: null, lockedAt: now() },
    });
    try {
      const result = await uploadJob({ ...job, attempts });
      const completedAt = now();
      updateStatus(job.galleryId, "succeeded", {
        attempts,
        nextRetryAt: null,
        lastError: null,
        job: {
          attempts,
          nextRetryAt: null,
          lastError: null,
          lockedAt: null,
          remoteUrl: result.remoteUrl,
          mime: result.mime,
          sha256: result.digest,
          byteSize: result.compressed.byteSize,
          width: result.compressed.width,
          height: result.compressed.height,
        },
        gallery: {
          filename: null,
          remoteUrl: result.remoteUrl,
          mime: result.mime,
          contentSha256: result.digest,
          uploadedAt: completedAt,
        },
      });
      try {
        await fs.promises.unlink(result.localPath);
      } catch (error) {
        if (error.code !== "ENOENT") logger({ kind: "remit_cleanup_error", galleryId: job.galleryId, message: errorMessage(error) });
      }
      logger({ kind: "remit_upload", galleryId: job.galleryId, remoteUrl: result.remoteUrl, bytes: result.compressed.byteSize });
      lastError = "";
    } catch (error) {
      const message = errorMessage(error);
      lastError = message;
      if (error instanceof BlockedUploadError) {
        updateStatus(job.galleryId, "blocked", {
          attempts,
          nextRetryAt: null,
          lastError: message,
          job: { attempts, nextRetryAt: null, lastError: message, lockedAt: null },
        });
      } else {
        const retryDelay = Math.max(retryMs, Number(error.retryAfterMs || 0));
        const nextRetryAt = now() + retryDelay;
        updateStatus(job.galleryId, "retry_wait", {
          attempts,
          nextRetryAt,
          lastError: message,
          job: {
            attempts,
            nextRetryAt,
            lastError: message,
            lockedAt: null,
            ...(error.discardRemote ? { remoteUrl: null } : {}),
          },
        });
      }
      logger({ kind: "remit_upload_error", galleryId: job.galleryId, status: error instanceof BlockedUploadError ? "blocked" : "retry_wait", message });
    }
  }

  async function processThumbnailJob(job) {
    const attempts = Number(job.thumbnailAttempts || 0) + 1;
    updateThumbnailStatus(job.galleryId, "uploading", {
      attempts,
      nextRetryAt: null,
      lastError: null,
      job: { thumbnailAttempts: attempts, thumbnailNextRetryAt: null, thumbnailLastError: null, lockedAt: now() },
    });
    try {
      const result = await uploadThumbnailJob({ ...job, thumbnailAttempts: attempts });
      const completedAt = now();
      updateThumbnailStatus(job.galleryId, "succeeded", {
        attempts,
        nextRetryAt: null,
        lastError: null,
        job: {
          thumbnailAttempts: attempts,
          thumbnailNextRetryAt: null,
          thumbnailLastError: null,
          lockedAt: null,
          thumbnailRemoteUrl: result.remoteUrl,
          thumbnailMime: result.mime,
          thumbnailSha256: result.digest,
          thumbnailByteSize: result.thumbnail.byteSize,
          thumbnailWidth: result.thumbnail.width,
          thumbnailHeight: result.thumbnail.height,
          thumbnailUploadedAt: completedAt,
        },
        gallery: {
          thumbnailUrl: result.remoteUrl,
          thumbnailMime: result.mime,
          thumbnailSha256: result.digest,
          thumbnailByteSize: result.thumbnail.byteSize,
          thumbnailUploadedAt: completedAt,
        },
      });
      try {
        await fs.promises.unlink(result.thumbnailPath);
      } catch (error) {
        if (error.code !== "ENOENT") logger({ kind: "remit_thumbnail_cleanup_error", galleryId: job.galleryId, message: errorMessage(error) });
      }
      logger({ kind: "remit_thumbnail_upload", galleryId: job.galleryId, remoteUrl: result.remoteUrl, bytes: result.thumbnail.byteSize });
      lastError = "";
    } catch (error) {
      const message = errorMessage(error);
      lastError = message;
      if (error instanceof BlockedUploadError) {
        updateThumbnailStatus(job.galleryId, "blocked", {
          attempts,
          nextRetryAt: null,
          lastError: message,
          job: { thumbnailAttempts: attempts, thumbnailNextRetryAt: null, thumbnailLastError: message, lockedAt: null },
        });
      } else {
        const retryDelay = Math.max(retryMs, Number(error.retryAfterMs || 0));
        const nextRetryAt = now() + retryDelay;
        updateThumbnailStatus(job.galleryId, "retry_wait", {
          attempts,
          nextRetryAt,
          lastError: message,
          job: { thumbnailAttempts: attempts, thumbnailNextRetryAt: nextRetryAt, thumbnailLastError: message, lockedAt: null, ...(error.discardRemote ? { thumbnailRemoteUrl: null } : {}) },
        });
      }
      logger({ kind: "remit_thumbnail_upload_error", galleryId: job.galleryId, status: error instanceof BlockedUploadError ? "blocked" : "retry_wait", message });
    }
  }

  async function runNext() {
    if (running || stopped || !uploadsEnabled) return;
    const task = nextTask();
    if (!task) {
      scheduleNextDue();
      return;
    }
    running = true;
    try {
      if (task.variant === "thumbnail") await processThumbnailJob(task);
      else await processOriginalJob(task);
    } finally {
      running = false;
      schedule(paceMs);
    }
  }

  function stageHistoricalRows() {
    const rows = db
      .prepare(
        `SELECT g.* FROM gallery g
         LEFT JOIN image_upload_jobs j ON j.galleryId = g.id AND j.variant='original'
         WHERE g.filename IS NOT NULL AND COALESCE(g.remoteUrl, '') = '' AND j.galleryId IS NULL
         ORDER BY g.createdAt ASC`,
      )
      .all();
    const insert = db.prepare(
      `INSERT OR IGNORE INTO image_upload_jobs
       (galleryId,variant,kind,status,attempts,nextRetryAt,lastError,localFilename,mime,sha256,byteSize,originalByteSize,createdAt,updatedAt)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const update = db.prepare(
      `UPDATE gallery SET mime=?,contentSha256=?,uploadStatus=?,uploadAttempts=0,nextRetryAt=?,lastUploadError=? WHERE id=?`,
    );
    const records = rows.map((row) => {
      const imagesRelative = path.join("images", path.basename(row.filename));
      const pendingRelative = path.join("pending-uploads", path.basename(row.filename));
      const imagesPath = safeLocalPath(dataDir, imagesRelative);
      const pendingPath = safeLocalPath(dataDir, pendingRelative);
      const localFilename = fs.existsSync(imagesPath) ? imagesRelative : pendingRelative;
      const localPath = fs.existsSync(imagesPath) ? imagesPath : pendingPath;
      const mime = normalizeMime(row.mime || mimeFromFilename(row.filename));
      if (!localPath || !fs.existsSync(localPath)) {
        return { id: row.id, status: "blocked", nextRetryAt: null, error: "The historical image file is missing.", localFilename, mime, sha256: "", byteSize: 0, createdAt: row.createdAt };
      }
      const buffer = fs.readFileSync(localPath);
      const supported = SUPPORTED_MIMES.has(mime);
      return {
        id: row.id,
        status: supported ? "pending" : "blocked",
        nextRetryAt: supported ? now() : null,
        error: supported ? null : "Unsupported historical image MIME.",
        localFilename,
        mime,
        sha256: sha256(buffer),
        byteSize: buffer.length,
        createdAt: row.createdAt,
      };
    });
    db.transaction((items) => {
      for (const record of items) {
        insert.run(record.id, "original", "historical", record.status, 0, record.nextRetryAt, record.error, record.localFilename, record.mime, record.sha256, record.byteSize, record.byteSize, record.createdAt || now(), now());
        update.run(record.mime, record.sha256, record.status, record.nextRetryAt, record.error, record.id);
      }
    })(records);
    const thumbnailRows = db.prepare(
       `SELECT g.*,j.thumbnailStatus FROM gallery g
       LEFT JOIN image_upload_jobs j ON j.galleryId = g.id AND j.variant='original'
       WHERE COALESCE(g.thumbnailUrl, '') = ''
         AND COALESCE(j.thumbnailStatus, '') = ''
       ORDER BY g.createdAt ASC`,
    ).all();
    const markThumbnail = db.prepare(
      `UPDATE image_upload_jobs
       SET thumbnailStatus='pending',thumbnailNextRetryAt=?,thumbnailLastError=NULL,updatedAt=?
       WHERE galleryId=? AND variant='original' AND COALESCE(thumbnailStatus, '') = ''`,
    );
    const markGalleryThumbnail = db.prepare(
      `UPDATE gallery SET thumbnailStatus='pending',thumbnailNextRetryAt=?,thumbnailLastUploadError=NULL WHERE id=? AND COALESCE(thumbnailStatus, '') NOT IN ('succeeded', 'blocked')`,
    );
    const timestamp = now();
    db.transaction((items) => {
      for (const row of items) {
        markThumbnail.run(timestamp, timestamp, row.id);
        markGalleryThumbnail.run(timestamp, row.id);
      }
    })(thumbnailRows);
    const originals = db.prepare("SELECT galleryId FROM image_upload_jobs WHERE variant='original'").all();
    for (const row of originals) syncThumbnailRow(row.galleryId);
    return records.length + thumbnailRows.length;
  }

  async function createGallery(record, inputBuffer, inputMime) {
    let buffer = inputBuffer;
    let mime = normalizeMime(inputMime);
    if (!buffer && record.url) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), UPLOAD_TIMEOUT_MS);
      try {
        const response = await fetchImpl(record.url, { signal: controller.signal });
        if (!response.ok) throw new Error("Source image returned HTTP " + response.status + ".");
        buffer = Buffer.from(await response.arrayBuffer());
        mime = normalizeMime(response.headers.get("content-type") || mime);
      } finally {
        clearTimeout(timeout);
      }
    }
    if (!buffer || !buffer.length) throw new Error("Generated image bytes are unavailable.");
    if (!SUPPORTED_MIMES.has(mime)) throw new Error("Unsupported generated image MIME: " + (mime || "unknown"));

    let compressed;
    let blockedError = null;
    try {
      compressed = await compressToLimit(buffer, mime, { targetBytes });
    } catch (error) {
      if (!(error instanceof BlockedUploadError)) throw error;
      blockedError = error;
      const metadata = await sharp(buffer).metadata();
      compressed = {
        buffer,
        mime,
        originalByteSize: buffer.length,
        byteSize: buffer.length,
        originalWidth: metadata.width || 0,
        originalHeight: metadata.height || 0,
        width: metadata.width || 0,
        height: metadata.height || 0,
      };
    }
    const filename = record.id + extensionForMime(mime);
    const relativeFilename = path.join("pending-uploads", filename);
    const localPath = safeLocalPath(dataDir, relativeFilename);
    await writeAtomic(localPath, compressed.buffer);
    let thumbnail;
    try {
      thumbnail = await compressThumbnail(buffer, { maxBytes: THUMBNAIL_MAX_BYTES });
    } catch (error) {
      if (!(error instanceof BlockedUploadError)) {
        try {
          await fs.promises.unlink(localPath);
        } catch (_) {}
        throw error;
      }
      thumbnail = { buffer: Buffer.alloc(0), mime: "image/webp", byteSize: 0, blocked: true, error: error.message };
    }
    const thumbnailFilename = record.id + ".thumb.webp";
    const thumbnailRelativeFilename = path.join("pending-uploads", thumbnailFilename);
    const thumbnailPath = safeLocalPath(dataDir, thumbnailRelativeFilename);
    if (thumbnail.buffer.length) await writeAtomic(thumbnailPath, thumbnail.buffer);
    const digest = sha256(compressed.buffer);
    const thumbnailDigest = thumbnail.buffer.length ? sha256(thumbnail.buffer) : null;
    const createdAt = record.createdAt || now();
    const status = blockedError ? "blocked" : "pending";
    const nextRetryAt = blockedError ? null : now();
    const lastErrorValue = blockedError ? blockedError.message : null;
    const thumbnailStatus = thumbnail.blocked ? "blocked" : "pending";
    const thumbnailNextRetryAt = thumbnail.blocked ? null : now();
    const thumbnailLastError = thumbnail.blocked ? (thumbnail.error || "Thumbnail compression failed.") : null;

    const transaction = db.transaction(() => {
      db.prepare(
        `INSERT INTO gallery
         (id,workspaceId,workspaceTitle,prompt,revisedPrompt,model,size,mode,filename,url,sourceDataUrl,favorite,createdAt,remoteUrl,mime,contentSha256,uploadStatus,uploadAttempts,nextRetryAt,lastUploadError,uploadedAt,thumbnailUrl,thumbnailMime,thumbnailSha256,thumbnailStatus,thumbnailAttempts,thumbnailNextRetryAt,thumbnailLastUploadError,thumbnailUploadedAt,thumbnailByteSize)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(record.id, record.workspaceId, record.workspaceTitle, record.prompt, record.revisedPrompt, record.model, record.size, record.mode, filename, record.url || null, record.sourceDataUrl || null, 0, createdAt, null, mime, digest, status, 0, nextRetryAt, lastErrorValue, null, null, "image/webp", thumbnailDigest, thumbnailStatus, 0, thumbnailNextRetryAt, thumbnailLastError, null, thumbnail.byteSize || null);
      db.prepare(
        `INSERT INTO image_upload_jobs
         (galleryId,kind,status,attempts,nextRetryAt,lastError,localFilename,mime,sha256,byteSize,originalByteSize,originalWidth,originalHeight,width,height,thumbnailStatus,thumbnailAttempts,thumbnailNextRetryAt,thumbnailLastError,thumbnailFilename,thumbnailMime,thumbnailSha256,thumbnailByteSize,thumbnailOriginalByteSize,thumbnailOriginalWidth,thumbnailOriginalHeight,thumbnailWidth,thumbnailHeight,createdAt,updatedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(record.id, "new", status, 0, nextRetryAt, lastErrorValue, relativeFilename, mime, digest, compressed.byteSize, compressed.originalByteSize, compressed.originalWidth, compressed.originalHeight, compressed.width, compressed.height, thumbnailStatus, 0, thumbnailNextRetryAt, thumbnailLastError, thumbnail.buffer.length ? thumbnailRelativeFilename : null, "image/webp", thumbnailDigest, thumbnail.byteSize || null, thumbnail.originalByteSize || null, thumbnail.originalWidth || null, thumbnail.originalHeight || null, thumbnail.width || null, thumbnail.height || null, createdAt, now());
      db.prepare(
        `INSERT INTO image_upload_jobs
         (galleryId,variant,kind,status,attempts,nextRetryAt,lastError,localFilename,mime,sha256,byteSize,originalByteSize,originalWidth,originalHeight,width,height,remoteUrl,createdAt,updatedAt)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(record.id, "thumbnail", "new", thumbnailStatus, 0, thumbnailNextRetryAt, thumbnailLastError, thumbnail.buffer.length ? thumbnailRelativeFilename : null, "image/webp", thumbnailDigest, thumbnail.byteSize || null, thumbnail.originalByteSize || null, thumbnail.originalWidth || null, thumbnail.originalHeight || null, thumbnail.width || null, thumbnail.height || null, null, createdAt, now());
    });
    try {
      transaction();
    } catch (error) {
      try {
        await fs.promises.unlink(localPath);
      } catch (_) {}
      try {
        await fs.promises.unlink(thumbnailPath);
      } catch (_) {}
      throw error;
    }
    schedule(0);
    return getGallery(record.id);
  }

  function cleanupCompletedFiles() {
    const rows = db.prepare("SELECT localFilename,thumbnailFilename FROM image_upload_jobs WHERE status='succeeded' OR thumbnailStatus='succeeded'").all();
    for (const row of rows) {
      for (const relative of [row.localFilename, row.thumbnailFilename]) {
        const filePath = safeLocalPath(dataDir, relative);
        if (filePath && fs.existsSync(filePath)) {
          try {
            fs.unlinkSync(filePath);
          } catch (_) {}
        }
      }
    }
  }

  function start() {
    stopped = false;
    const timestamp = now();
    db.prepare("UPDATE image_upload_jobs SET status='pending',nextRetryAt=?,lockedAt=NULL,updatedAt=? WHERE variant='original' AND status='uploading'").run(timestamp, timestamp);
    db.prepare("UPDATE image_upload_jobs SET status='pending',nextRetryAt=?,lockedAt=NULL,updatedAt=? WHERE variant='thumbnail' AND status='uploading'").run(timestamp, timestamp);
    db.prepare("UPDATE image_upload_jobs SET thumbnailStatus='pending',thumbnailNextRetryAt=?,lockedAt=NULL,updatedAt=? WHERE variant='original' AND thumbnailStatus='uploading'").run(timestamp, timestamp);
    db.prepare("UPDATE gallery SET uploadStatus='pending',nextRetryAt=?,lastUploadError='Recovered after service restart.' WHERE uploadStatus='uploading'").run(timestamp);
    db.prepare("UPDATE gallery SET thumbnailStatus='pending',thumbnailNextRetryAt=?,thumbnailLastUploadError='Recovered after service restart.' WHERE thumbnailStatus='uploading'").run(timestamp);
    const migrated = stageHistoricalRows();
    cleanupCompletedFiles();
    schedule(0);
    return migrated;
  }

  function stop() {
    stopped = true;
    clearTimer();
    for (const controller of activeControllers) controller.abort();
  }

  function retry(galleryId, variant) {
    const job = db.prepare("SELECT * FROM image_upload_jobs WHERE galleryId = ? AND variant='original'").get(galleryId);
    if (!job) return false;
    const due = now();
    if (variant === "thumbnail") {
      if (job.thumbnailStatus === "succeeded" || job.thumbnailStatus === "canceled") return false;
      updateThumbnailStatus(galleryId, "pending", {
        attempts: job.thumbnailAttempts,
        nextRetryAt: due,
        lastError: null,
        job: { thumbnailNextRetryAt: due, thumbnailLastError: null, lockedAt: null },
      });
    } else if (variant === "original") {
      if (job.status === "succeeded" || job.status === "canceled") return false;
      updateStatus(galleryId, "pending", {
        attempts: job.attempts,
        nextRetryAt: due,
        lastError: null,
        job: { nextRetryAt: due, lastError: null, lockedAt: null },
      });
    } else {
      let changed = false;
      if (job.status !== "succeeded" && job.status !== "canceled") {
        updateStatus(galleryId, "pending", { attempts: job.attempts, nextRetryAt: due, lastError: null, job: { nextRetryAt: due, lastError: null, lockedAt: null } });
        changed = true;
      }
      if (job.thumbnailStatus !== "succeeded" && job.thumbnailStatus !== "canceled") {
        updateThumbnailStatus(galleryId, "pending", { attempts: job.thumbnailAttempts, nextRetryAt: due, lastError: null, job: { thumbnailNextRetryAt: due, thumbnailLastError: null, lockedAt: null } });
        changed = true;
      }
      if (!changed) return false;
    }
    schedule(0);
    return true;
  }

  function deleteGallery(galleryId) {
    const job = db.prepare("SELECT * FROM image_upload_jobs WHERE galleryId = ? AND variant='original'").get(galleryId);
    const gallery = db.prepare("SELECT * FROM gallery WHERE id = ?").get(galleryId);
    db.transaction(() => {
      if (job) db.prepare("DELETE FROM image_upload_jobs WHERE galleryId = ?").run(galleryId);
      db.prepare("DELETE FROM gallery WHERE id = ?").run(galleryId);
    })();
    const candidates = [
      job && job.localFilename,
      job && job.thumbnailFilename,
      gallery && gallery.filename && path.join("images", path.basename(gallery.filename)),
      gallery && gallery.filename && path.join("pending-uploads", path.basename(gallery.filename)),
    ].filter(Boolean);
    for (const relative of candidates) {
      const filePath = safeLocalPath(dataDir, relative);
      if (filePath) {
        try {
          fs.unlinkSync(filePath);
        } catch (_) {}
      }
    }
    return { deleted: Boolean(gallery), remoteRetained: Boolean(gallery && gallery.remoteUrl) };
  }

  function listUploads(limit = 100) {
    const counts = {};
    const originalCounts = {};
    const thumbnailCounts = {};
    for (const row of db.prepare("SELECT status,COUNT(*) AS count FROM image_upload_jobs WHERE variant='original' GROUP BY status").all()) {
      originalCounts[row.status] = row.count;
      counts[row.status] = (counts[row.status] || 0) + row.count;
    }
    for (const row of db.prepare("SELECT status,COUNT(*) AS count FROM image_upload_jobs WHERE variant='thumbnail' GROUP BY status").all()) {
      thumbnailCounts[row.status] = row.count;
      counts[row.status] = (counts[row.status] || 0) + row.count;
    }
    const originalItems = db.prepare(
      `SELECT j.*,g.workspaceTitle,g.prompt,g.remoteUrl AS galleryRemoteUrl,g.filename,'original' AS variant
       FROM image_upload_jobs j JOIN gallery g ON g.id=j.galleryId
       WHERE j.variant='original'`,
    ).all();
    const thumbnailItems = db.prepare(
      `SELECT j.galleryId,j.kind,j.status,j.attempts,j.nextRetryAt,j.lastError,j.localFilename,j.mime,j.sha256,j.byteSize,j.originalByteSize,j.originalWidth,j.originalHeight,j.width,j.height,j.remoteUrl,j.createdAt,j.updatedAt,j.lockedAt,g.workspaceTitle,g.prompt,g.remoteUrl AS galleryRemoteUrl,g.filename,'thumbnail' AS variant
       FROM image_upload_jobs j JOIN gallery g ON g.id=j.galleryId
       WHERE j.variant='thumbnail'`,
    ).all();
    const items = originalItems.concat(thumbnailItems).sort((a, b) => {
      const rank = { uploading: 0, pending: 1, retry_wait: 2, blocked: 3, canceled: 4, succeeded: 5 };
      return (rank[a.status] ?? 9) - (rank[b.status] ?? 9) || a.createdAt - b.createdAt;
    }).slice(0, Math.max(1, Math.min(500, limit)));
    const historical = db
      .prepare(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) AS succeeded,
                SUM(CASE WHEN status='blocked' THEN 1 ELSE 0 END) AS blocked
         FROM image_upload_jobs WHERE kind='historical' AND variant='thumbnail'`,
      )
      .get();
    return {
      counts,
      breakdown: { original: originalCounts, thumbnail: thumbnailCounts, total: counts },
      items,
      historical: { total: historical.total || 0, succeeded: historical.succeeded || 0, blocked: historical.blocked || 0 },
      worker: { running, enabled: uploadsEnabled, lastError },
    };
  }

  function getHealth() {
    const summary = listUploads(1);
    return { counts: summary.counts, worker: summary.worker, historical: summary.historical };
  }

  function getGallery(galleryId) {
    const record = db.prepare("SELECT * FROM gallery WHERE id = ?").get(galleryId);
    if (!record) return null;
    const job = db.prepare("SELECT thumbnailFilename,thumbnailStatus FROM image_upload_jobs WHERE galleryId = ? AND variant='original'").get(galleryId);
    const thumbnailPath = safeLocalPath(dataDir, job && job.thumbnailFilename);
    record.thumbnailReady = Boolean(record.thumbnailUrl || (thumbnailPath && fs.existsSync(thumbnailPath)));
    return record;
  }

  async function getContent(galleryId) {
    const gallery = getGallery(galleryId);
    if (!gallery) return null;
    const job = db.prepare("SELECT * FROM image_upload_jobs WHERE galleryId = ? AND variant='original'").get(galleryId);
    if (job && job.localFilename) {
      const localPath = safeLocalPath(dataDir, job.localFilename);
      if (localPath && fs.existsSync(localPath)) return { buffer: await fs.promises.readFile(localPath), mime: normalizeMime(job.mime), source: "local" };
    }
    if (gallery.filename) {
      for (const directory of ["images", "pending-uploads"]) {
        const localPath = safeLocalPath(dataDir, path.join(directory, path.basename(gallery.filename)));
        if (localPath && fs.existsSync(localPath)) return { buffer: await fs.promises.readFile(localPath), mime: normalizeMime(gallery.mime || mimeFromFilename(localPath)), source: "local" };
      }
    }
    if (!isValidRemitUrl(gallery.remoteUrl)) return null;
    const response = await fetchImpl(gallery.remoteUrl, { redirect: "manual", headers: { Accept: gallery.mime || "image/*" } });
    if (!response.ok || !isValidRemitUrl(response.url || gallery.remoteUrl)) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (gallery.contentSha256 && sha256(buffer) !== gallery.contentSha256) return null;
    const headerMime = normalizeMime(response.headers.get("content-type"));
    const mime = SUPPORTED_MIMES.has(headerMime) ? headerMime : detectImageMime(buffer) || normalizeMime(gallery.mime);
    return { buffer, mime, source: "remote" };
  }

  async function getThumbnail(galleryId) {
    const gallery = getGallery(galleryId);
    if (!gallery) return null;
    const job = db.prepare("SELECT * FROM image_upload_jobs WHERE galleryId = ? AND variant='original'").get(galleryId);
    const localPath = safeLocalPath(dataDir, job && job.thumbnailFilename);
    if (localPath && fs.existsSync(localPath)) {
      const buffer = await fs.promises.readFile(localPath);
      if (detectImageMime(buffer) === "image/webp") return { buffer, mime: "image/webp", source: "local" };
    }
    if (!isValidRemitUrl(gallery.thumbnailUrl)) return null;
    const response = await fetchImpl(gallery.thumbnailUrl, { redirect: "manual", headers: { Accept: "image/webp" } });
    if (!response.ok || !isValidRemitUrl(response.url || gallery.thumbnailUrl)) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    const responseMime = normalizeMime(response.headers.get("content-type"));
    if (responseMime && responseMime !== "image/webp" && responseMime !== "application/octet-stream" && responseMime !== "binary/octet-stream") return null;
    if (buffer.length >= THUMBNAIL_MAX_BYTES || detectImageMime(buffer) !== "image/webp") return null;
    if (gallery.thumbnailSha256 && sha256(buffer) !== gallery.thumbnailSha256) return null;
    return { buffer, mime: "image/webp", source: "remote" };
  }

  return {
    start,
    stop,
    retry,
    deleteGallery,
    createGallery,
    listUploads,
    getHealth,
    getGallery,
    getContent,
    getThumbnail,
    runNext,
    stageHistoricalRows,
  };
}

module.exports = {
  BlockedUploadError,
  DEFAULT_PACE_MS,
  DEFAULT_RETRY_MS,
  MAX_UPLOAD_BYTES,
  REMIT_ORIGIN,
  REMIT_UPLOAD_URL,
  TARGET_UPLOAD_BYTES,
  THUMBNAIL_MAX_BYTES,
  THUMBNAIL_MAX_EDGE,
  THUMBNAIL_MIN_SHORT_EDGE,
  compressToLimit,
  compressThumbnail,
  createRemitUploadManager,
  detectImageMime,
  extensionForMime,
  isValidRemitUrl,
  mimeFromFilename,
  normalizeMime,
  parseRetryAfter,
  sha256,
};
