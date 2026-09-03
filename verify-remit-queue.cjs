const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Database = require("better-sqlite3");
const sharp = require("sharp");
const {
  DEFAULT_RETRY_MS,
  REMIT_UPLOAD_URL,
  compressToLimit,
  compressThumbnail,
  createRemitUploadManager,
  isValidRemitUrl,
  parseRetryAfter,
  sha256,
} = require("./remit-upload.cjs");

function createBaseDb(filePath) {
  const db = new Database(filePath);
  db.exec(`
    CREATE TABLE gallery (
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
      createdAt INTEGER
    );
  `);
  return db;
}

async function makeImage(mime, width = 96, height = 80) {
  const pixels = crypto.randomBytes(width * height * 3);
  let pipeline = sharp(pixels, { raw: { width, height, channels: 3 } });
  if (mime === "image/jpeg") pipeline = pipeline.jpeg({ quality: 92 });
  else if (mime === "image/webp") pipeline = pipeline.webp({ quality: 92 });
  else pipeline = pipeline.png({ compressionLevel: 3 });
  return pipeline.toBuffer();
}

async function waitForStatus(db, id, expected, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const row = db.prepare("SELECT * FROM image_upload_jobs WHERE galleryId = ? AND variant='original'").get(id);
    if (row && expected.includes(row.status)) return row;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const row = db.prepare("SELECT * FROM image_upload_jobs WHERE galleryId = ? AND variant='original'").get(id);
  throw new Error("Timed out waiting for " + id + " status " + expected.join("/") + "; current=" + (row && row.status));
}

async function waitForThumbnailStatus(db, id, expected, timeoutMs = 3000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const row = db.prepare("SELECT * FROM image_upload_jobs WHERE galleryId = ? AND variant='thumbnail'").get(id);
    if (row && expected.includes(row.status)) return row;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const row = db.prepare("SELECT * FROM image_upload_jobs WHERE galleryId = ? AND variant='thumbnail'").get(id);
  throw new Error("Timed out waiting for thumbnail " + id + " status " + expected.join("/") + "; current=" + (row && row.status));
}

async function verifyQueue() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lucen-remit-test-"));
  const db = createBaseDb(path.join(tempDir, "queue.db"));
  const uploadAttempts = new Map();
  const uploadedBytes = new Map();
  const requestEvidence = [];
  let hashMismatchPending = true;

  const fetchImpl = async (url, options = {}) => {
    if (url === REMIT_UPLOAD_URL) {
      assert.strictEqual(options.method, "POST");
      assert.strictEqual(options.headers.Accept, "application/json");
      assert.strictEqual(options.headers.Referer, "https://img.remit.ee/");
      assert.ok(options.body instanceof FormData);
      const file = options.body.get("file");
      assert.ok(file instanceof Blob);
      const filename = file.name;
      const id = path.basename(filename, path.extname(filename));
      const attempts = (uploadAttempts.get(id) || 0) + 1;
      uploadAttempts.set(id, attempts);
      uploadedBytes.set(id, Buffer.from(await file.arrayBuffer()));
      requestEvidence.push({ id, filename, mime: file.type, attempts });

      if (id === "retry-case" && attempts === 1) {
        return new Response("rate limited", { status: 429, headers: { "Retry-After": "0" } });
      }
      const field = id === "url-case" ? "url" : id === "preview-case" ? "previewUrl" : "directUrl";
      return new Response(JSON.stringify({ success: true, [field]: "https://img.remit.ee/api/file/" + filename }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }

    const parsed = new URL(url);
    assert.strictEqual(parsed.origin, "https://img.remit.ee");
    assert.ok(parsed.pathname.startsWith("/api/file/"));
    assert.strictEqual(options.method || "GET", "GET");
    const filename = path.basename(parsed.pathname);
    const id = path.basename(filename, path.extname(filename));
    const expected = uploadedBytes.get(id);
    assert.ok(expected);
    let body = expected;
    if (id === "hash-case" && hashMismatchPending) {
      hashMismatchPending = false;
      body = Buffer.concat([expected, Buffer.from([0])]);
    }
    const contentType = id === "preview-case" ? "application/octet-stream" : requestEvidence.find((item) => item.id === id).mime;
    return new Response(body, { status: 200, headers: { "Content-Type": contentType } });
  };

  const manager = createRemitUploadManager({
    db,
    dataDir: tempDir,
    fetchImpl,
    retryMs: 60_000,
    paceMs: 0,
  });
  manager.stop();

  try {
    const png = await makeImage("image/png");
    for (const id of ["retry-case", "hash-case", "url-case", "preview-case"]) {
      await manager.createGallery({
        id,
        workspaceId: "workspace-test",
        workspaceTitle: "Test",
        prompt: "mock only",
        revisedPrompt: "",
        model: "gpt-image-2",
        size: "1024x1024",
        mode: "text",
        createdAt: Date.now(),
      }, png, "image/png");
      assert.deepStrictEqual(
        db.prepare("SELECT variant FROM image_upload_jobs WHERE galleryId = ? ORDER BY variant").all(id).map((row) => row.variant),
        ["original", "thumbnail"],
      );
    }

    manager.start();
    const firstRetry = await waitForStatus(db, "retry-case", ["retry_wait"]);
    assert.strictEqual(firstRetry.attempts, 1);
    assert.ok(firstRetry.nextRetryAt - firstRetry.updatedAt >= 60_000);
    assert.ok(fs.existsSync(path.join(tempDir, firstRetry.localFilename)));
    assert.strictEqual(manager.retry("retry-case"), true);
    await waitForStatus(db, "retry-case", ["succeeded"]);

    const hashRetry = await waitForStatus(db, "hash-case", ["retry_wait"]);
    assert.match(hashRetry.lastError, /byte length|SHA-256/);
    assert.ok(fs.existsSync(path.join(tempDir, hashRetry.localFilename)));
    assert.strictEqual(manager.retry("hash-case"), true);
    await waitForStatus(db, "hash-case", ["succeeded"]);
      await waitForStatus(db, "url-case", ["succeeded"]);
    await waitForStatus(db, "preview-case", ["succeeded"]);
    for (const id of ["retry-case", "hash-case", "url-case", "preview-case"]) {
      await waitForThumbnailStatus(db, id, ["succeeded"]);
    }

    for (const id of ["retry-case", "hash-case", "url-case", "preview-case"]) {
      const gallery = db.prepare("SELECT * FROM gallery WHERE id = ?").get(id);
      const job = db.prepare("SELECT * FROM image_upload_jobs WHERE galleryId = ? AND variant='original'").get(id);
      const thumbnailJob = db.prepare("SELECT * FROM image_upload_jobs WHERE galleryId = ? AND variant='thumbnail'").get(id);
      assert.strictEqual(gallery.uploadStatus, "succeeded");
      assert.strictEqual(gallery.filename, null);
      assert.ok(isValidRemitUrl(gallery.remoteUrl));
      assert.strictEqual(gallery.contentSha256, sha256(uploadedBytes.get(id)));
      assert.ok(!fs.existsSync(path.join(tempDir, job.localFilename)));
      assert.strictEqual(gallery.thumbnailStatus, "succeeded");
      assert.strictEqual(thumbnailJob.status, "succeeded");
      assert.ok(/^https:\/\/img\.remit\.ee\/api\/file\//.test(gallery.thumbnailUrl));
      assert.strictEqual(gallery.thumbnailMime, "image/webp");
      assert.ok(gallery.thumbnailByteSize < 100000);
      assert.ok(!fs.existsSync(path.join(tempDir, job.thumbnailFilename)));
      const content = await manager.getContent(id);
      assert.strictEqual(sha256(content.buffer), gallery.contentSha256);
      assert.strictEqual(content.source, "remote");
      assert.strictEqual(content.mime, "image/png");
      const thumbnail = await manager.getThumbnail(id);
      assert.strictEqual(thumbnail.source, "remote");
      assert.strictEqual(thumbnail.mime, "image/webp");
      assert.ok(thumbnail.buffer.length < 100000);
    }

    assert.strictEqual(DEFAULT_RETRY_MS, 5 * 60 * 1000);
    assert.strictEqual(parseRetryAfter("360", 0), 360_000);
    assert.strictEqual(isValidRemitUrl("https://img.remit.ee/api/file/a.png"), true);
    assert.strictEqual(isValidRemitUrl("https://img.remit.ee.evil.example/api/file/a.png"), false);
    assert.strictEqual(isValidRemitUrl("https://img.remit.ee/other/a.png"), false);

    const columns = new Set(db.prepare("PRAGMA table_info(gallery)").all().map((row) => row.name));
    for (const column of ["remoteUrl", "mime", "contentSha256", "uploadStatus", "uploadedAt"]) assert.ok(columns.has(column));
  } finally {
    manager.stop();
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function verifyHistoryRecovery() {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "lucen-remit-history-"));
  const db = createBaseDb(path.join(tempDir, "history.db"));
  fs.mkdirSync(path.join(tempDir, "images"), { recursive: true });
  const buffer = await makeImage("image/jpeg");
  fs.writeFileSync(path.join(tempDir, "images", "old.jpg"), buffer);
  db.prepare(
    `INSERT INTO gallery (id,workspaceId,workspaceTitle,prompt,revisedPrompt,model,size,mode,filename,url,sourceDataUrl,favorite,createdAt)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  ).run("old", "legacy", "Legacy", "old", "", "gpt-image-2", "auto", "text", "old.jpg", "", null, 0, Date.now());

  const manager = createRemitUploadManager({ db, dataDir: tempDir, uploadsEnabled: false });
  try {
    assert.strictEqual(manager.stageHistoricalRows(), 2);
    assert.strictEqual(manager.stageHistoricalRows(), 0);
    let job = db.prepare("SELECT * FROM image_upload_jobs WHERE galleryId='old'").get();
    assert.strictEqual(job.kind, "historical");
    assert.strictEqual(job.status, "pending");
    assert.strictEqual(job.thumbnailStatus, "pending");
    db.prepare("UPDATE image_upload_jobs SET status='uploading'").run();
    db.prepare("UPDATE gallery SET uploadStatus='uploading'").run();
    manager.start();
    job = db.prepare("SELECT * FROM image_upload_jobs WHERE galleryId='old'").get();
    assert.strictEqual(job.status, "pending");
    assert.match(db.prepare("SELECT lastUploadError FROM gallery WHERE id='old'").get().lastUploadError, /restart/i);
  } finally {
    manager.stop();
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function verifyCompression() {
  const width = 256;
  const height = 256;
  const pixels = crypto.randomBytes(width * height * 3);
  for (const mime of ["image/jpeg", "image/png", "image/webp"]) {
    let pipeline = sharp(pixels, { raw: { width, height, channels: 3 } });
    if (mime === "image/jpeg") pipeline = pipeline.jpeg({ quality: 100 });
    else if (mime === "image/webp") pipeline = pipeline.webp({ quality: 100, lossless: true });
    else pipeline = pipeline.png({ compressionLevel: 0 });
    const original = await pipeline.toBuffer();
    const targetBytes = 24 * 1024;
    assert.ok(original.length > targetBytes);
    const compressed = await compressToLimit(original, mime, { targetBytes, minimumShortEdge: 32 });
    assert.strictEqual(compressed.mime, mime);
    assert.ok(compressed.byteSize <= targetBytes);
    const metadata = await sharp(compressed.buffer).metadata();
    const expectedFormat = mime === "image/jpeg" ? "jpeg" : mime.split("/")[1];
    assert.strictEqual(metadata.format, expectedFormat);

    const thumbnail = await compressThumbnail(original, { maxBytes: 100000, maxEdge: 160, minimumShortEdge: 32 });
    assert.strictEqual(thumbnail.mime, "image/webp");
    assert.ok(thumbnail.byteSize < 100000);
    assert.strictEqual((await sharp(thumbnail.buffer).metadata()).format, "webp");
  }
}

(async () => {
  await verifyQueue();
  await verifyHistoryRecovery();
  await verifyCompression();
  console.log("Remit queue verification passed: multipart, retries, remote integrity, migration, recovery, and same-format compression.");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
