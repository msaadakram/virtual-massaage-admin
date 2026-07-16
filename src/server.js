const path = require('path');
const crypto = require('crypto');

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const dotenv = require('dotenv');
const { MongoClient, GridFSBucket, ObjectId } = require('mongodb');
const jose = require('jose');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || '').trim() || 'change-me-admin-token';
const BASE_URL = (process.env.BASE_URL || '').trim();
const IS_VERCEL = Boolean(process.env.VERCEL);
const MONGODB_URI = (process.env.MONGODB_URI || '').trim();
const MONGODB_DB_NAME = (process.env.MONGODB_DB_NAME || 'vu-chat-app').trim() || 'vu-chat-app';
const JWT_SECRET = (process.env.JWT_SECRET || '').trim();
const ADMIN_USERNAME = (process.env.ADMIN_USERNAME || '').trim();
const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || '').trim();
const FIREBASE_PROJECT_ID = (process.env.FIREBASE_PROJECT_ID || 'vu-student-app-9ea23').trim() || 'vu-student-app-9ea23';

const PUBLIC_DIR = path.resolve(__dirname, '../public');

const NOTICE_SECTIONS = [
  { key: 'all', label: 'All Notices' },
  { key: 'notice-board', label: 'Notice Board' },
  { key: 'website-issues', label: 'VU Website Issues' },
  { key: 'exam-rules', label: 'VU Exam Rules' },
  { key: 'date-sheet', label: 'Date Sheet' },
  { key: 'paid-project', label: 'Paid Project' },
  { key: 'jobs', label: 'Jobs' },
  { key: 'vu-notice', label: 'VU Notice' },
  { key: 'learning-notice', label: 'Learning Notice' },
  { key: 'general', label: 'General' },
];

const TARGET_GROUPS = [
  { key: 'all', label: 'All Students' },
  { key: 'bscs', label: 'BSCS Group' },
  { key: 'bsit', label: 'BSIT Group' },
  { key: 'mcs', label: 'MCS Group' },
  { key: 'mba', label: 'MBA Group' },
  { key: 'paid-project-team', label: 'Paid Project Team' },
];

app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/admin-assets', express.static(PUBLIC_DIR));

let _mongoClient;
let _mongoDb;
let _gridFs;
let _mongoReadyPromise;

function assertMongoConfig() {
  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI is missing. Add it in environment variables.');
  }
}

async function ensureMongoReady() {
  if (_mongoReadyPromise) {
    return _mongoReadyPromise;
  }

  _mongoReadyPromise = (async () => {
    assertMongoConfig();

    if (!_mongoClient) {
      _mongoClient = new MongoClient(MONGODB_URI, {
        maxPoolSize: IS_VERCEL ? 5 : 20,
        minPoolSize: 0,
        connectTimeoutMS: 10000,
        serverSelectionTimeoutMS: 15000,
      });
      await _mongoClient.connect();
    }

    _mongoDb = _mongoClient.db(MONGODB_DB_NAME);
    _gridFs = new GridFSBucket(_mongoDb, { bucketName: 'media' });

    // Best-effort background index creation. Never awaited on the request path.
    Promise.all([
      _mongoDb.collection('messages').createIndex({ createdAt: 1 }),
      _mongoDb.collection('messages').createIndex({ createdAt: -1 }),
      _mongoDb.collection('messages').createIndex({ section: 1, targetGroup: 1, createdAt: -1 }),
      _mongoDb.collection('messages').createIndex({ pinned: -1, createdAt: -1 }),
      _mongoDb.collection('admins').createIndex({ username: 1 }, { unique: true }),
      _mongoDb.collection('resources').createIndex({ createdAt: -1 }),
      _mongoDb.collection('resources').createIndex({ category: 1, createdAt: -1 }),
      _mongoDb.collection('resources').createIndex({ uploaderUid: 1, createdAt: -1 }),
    ]).then(() => seedAdminIfNeeded()).catch((error) => {
      console.error('Database background setup warning:', error.message);
    });
  })();

  return _mongoReadyPromise;
}

async function getMessagesCollection() {
  await ensureMongoReady();
  return _mongoDb.collection('messages');
}

async function getResourcesCollection() {
  await ensureMongoReady();
  return _mongoDb.collection('resources');
}

async function getAdminsCollection() {
  await ensureMongoReady();
  return _mongoDb.collection('admins');
}

const SCRYPT_KEYLEN = 64;
const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, SCRYPT_PARAMS);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.startsWith('scrypt$')) return false;
  const parts = stored.split('$');
  if (parts.length !== 3) return false;
  const salt = Buffer.from(parts[1], 'hex');
  const expected = Buffer.from(parts[2], 'hex');
  const computed = crypto.scryptSync(password, salt, expected.length, SCRYPT_PARAMS);
  return crypto.timingSafeEqual(computed, expected);
}

async function seedAdminIfNeeded() {
  if (!ADMIN_USERNAME || !ADMIN_PASSWORD) return;
  try {
    const admins = await getAdminsCollection();
    const existing = await admins.findOne({ username: ADMIN_USERNAME });
    if (!existing) {
      await admins.insertOne({
        username: ADMIN_USERNAME,
        passwordHash: await hashPassword(ADMIN_PASSWORD),
        updatedAt: new Date(),
      });
    } else if (!verifyPassword(ADMIN_PASSWORD, existing.passwordHash)) {
      // .env password changed since last boot — resync the stored hash.
      await admins.updateOne(
        { _id: existing._id },
        { $set: { passwordHash: await hashPassword(ADMIN_PASSWORD), updatedAt: new Date() } },
      );
    }
  } catch (error) {
    console.error('Admin seed failed:', error.message);
  }
}

function signAdminToken(username) {
  if (!JWT_SECRET) {
    throw new Error('JWT_SECRET is not configured.');
  }
  return new jose.SignJWT({ sub: username, role: 'admin' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('7d')
    .sign(new TextEncoder().encode(JWT_SECRET));
}

async function verifyAdminToken(token) {
  if (!JWT_SECRET) return null;
  try {
    const { payload } = await jose.jwtVerify(
      token,
      new TextEncoder().encode(JWT_SECRET),
      { algorithms: ['HS256'] },
    );
    if (payload && payload.role === 'admin' && payload.sub) {
      return { username: payload.sub, role: 'admin' };
    }
    return null;
  } catch (_) {
    return null;
  }
}

const _firebaseJwks = new jose.createRemoteJWKSet(
  new URL('https://www.googleapis.com/robot/v1/metadata/jwk/securetoken@system.gserviceaccount.com'),
);

async function verifyFirebaseUser(idToken) {
  if (!idToken) throw new Error('Missing id token.');
  const { payload } = await jose.jwtVerify(idToken, _firebaseJwks, {
    issuer: `https://securetoken.googleapis.com/${FIREBASE_PROJECT_ID}`,
    audience: FIREBASE_PROJECT_ID,
  });
  return {
    uid: payload.sub,
    email: payload.email || '',
    name: payload.name || payload.email?.split('@')[0] || 'User',
  };
}

async function saveMediaToGridFs({ buffer, filename, mimeType, source = 'admin-upload' }) {
  await ensureMongoReady();

  const uploadStream = _gridFs.openUploadStream(filename, {
    contentType: mimeType,
    metadata: {
      createdAt: new Date(),
      source,
    },
  });

  await new Promise((resolve, reject) => {
    uploadStream.once('error', reject);
    uploadStream.once('finish', resolve);
    uploadStream.end(buffer);
  });

  return uploadStream.id;
}

async function deleteGridFsById(idOrObjectId) {
  await ensureMongoReady();
  const objectId = idOrObjectId instanceof ObjectId ? idOrObjectId : new ObjectId(String(idOrObjectId));
  const files = await _gridFs.find({ _id: objectId }).limit(1).toArray();
  if (!files.length) return false;
  await _gridFs.delete(objectId);
  return true;
}

function extractMediaIdFromUrl(url) {
  if (typeof url !== 'string' || !url) return null;
  const match = url.match(/\/api\/media\/([0-9a-fA-F]{24})/);
  if (!match) return null;
  return ObjectId.isValid(match[1]) ? match[1] : null;
}

function serializeMessage(doc) {
  if (!doc) return null;
  return {
    id: doc._id.toString(),
    text: doc.text || '',
    mediaUrl: doc.mediaUrl || '',
    mediaType: doc.mediaType || 'text',
    senderRole: doc.senderRole || 'admin',
    senderName: doc.senderName || 'Admin',
    section: doc.section || 'general',
    targetGroup: doc.targetGroup || 'all',
    pinned: Boolean(doc.pinned),
    createdAt: (doc.createdAt instanceof Date ? doc.createdAt : new Date(doc.createdAt || Date.now())).toISOString(),
    updatedAt: doc.updatedAt
      ? (doc.updatedAt instanceof Date ? doc.updatedAt : new Date(doc.updatedAt)).toISOString()
      : null,
  };
}

function isKnownSection(value) {
  return NOTICE_SECTIONS.some((item) => item.key === value);
}

function isKnownGroup(value) {
  return TARGET_GROUPS.some((item) => item.key === value);
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 },
});

const RESOURCE_CATEGORIES = [
  { key: 'assignment', label: 'Assignment' },
  { key: 'past-paper', label: 'Past Paper' },
  { key: 'notes', label: 'Notes' },
  { key: 'book', label: 'Book' },
  { key: 'quiz', label: 'Quiz' },
  { key: 'handouts', label: 'Handouts' },
  { key: 'lectures', label: 'Lectures' },
  { key: 'slides', label: 'Slides' },
  { key: 'syllabus', label: 'Syllabus' },
  { key: 'other', label: 'Other' },
];

function isKnownCategory(value) {
  return RESOURCE_CATEGORIES.some((item) => item.key === value);
}

async function resolveAdminRequest(req) {
  // Session (Bearer) takes precedence.
  const authHeader = (req.headers['authorization'] || '').toString().trim();
  if (authHeader.toLowerCase().startsWith('bearer ')) {
    const token = authHeader.slice(7).trim();
    const session = await verifyAdminToken(token);
    if (session) return session;
  }
  // Legacy static token fallback.
  if (isAdmin(req)) return { username: 'admin', role: 'admin', legacy: true };
  return null;
}

function isAdmin(req) {
  const token = (req.headers['x-admin-token'] || '').toString().trim();
  return token.length > 0 && token === ADMIN_TOKEN;
}

async function requireAdmin(req, res) {
  const session = await resolveAdminRequest(req);
  if (!session) {
    res.status(403).json({ error: 'Admin authentication required' });
    return null;
  }
  return session;
}

async function requireAdminSession(req, res) {
  const authHeader = (req.headers['authorization'] || '').toString().trim();
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    res.status(401).json({ error: 'Admin login required' });
    return null;
  }
  const session = await verifyAdminToken(authHeader.slice(7).trim());
  if (!session) {
    res.status(401).json({ error: 'Invalid or expired admin session' });
    return null;
  }
  return session;
}

function detectMediaType(mimeType = '') {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'file';
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function resolvePublicBaseUrl(req) {
  if (BASE_URL) {
    return BASE_URL;
  }

  const forwardedProto = (req.headers['x-forwarded-proto'] || '').toString().split(',')[0].trim();
  const proto = forwardedProto || req.protocol || 'http';
  const host = (req.headers.host || '').toString().trim();

  if (host) {
    return `${proto}://${host}`;
  }

  return `http://localhost:${PORT}`;
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'chat-backend',
    runtime: IS_VERCEL ? 'vercel' : 'node',
    database: MONGODB_DB_NAME,
    timestamp: new Date().toISOString(),
  });
});

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, 'admin.html'));
});

app.get('/api/meta', (_req, res) => {
  res.json({
    sections: NOTICE_SECTIONS,
    groups: TARGET_GROUPS,
    resourceCategories: RESOURCE_CATEGORIES,
  });
});

app.get('/api/admin/whoami', async (req, res) => {
  const session = await resolveAdminRequest(req);
  if (!session) return res.status(401).json({ authenticated: false });
  res.json({ authenticated: true, username: session.username, legacy: Boolean(session.legacy) });
});

app.post('/api/admin/login', async (req, res) => {
  try {
    const username = (req.body?.username || '').toString().trim();
    const password = (req.body?.password || '').toString();
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    const admins = await getAdminsCollection();
    const admin = await admins.findOne({ username });
    if (!admin || !verifyPassword(password, admin.passwordHash)) {
      return res.status(401).json({ error: 'Invalid username or password.' });
    }

    const token = await signAdminToken(admin.username);
    return res.json({ token, admin: { username: admin.username } });
  } catch (error) {
    if (String(error.message || '').includes('JWT_SECRET')) {
      return res.status(500).json({ error: 'JWT_SECRET is not configured on the server.' });
    }
    return res.status(500).json({ error: 'Login failed', details: error.message });
  }
});

app.post('/api/admin/change-password', async (req, res) => {
  const session = await requireAdminSession(req, res);
  if (!session) return;
  try {
    const currentPassword = (req.body?.currentPassword || '').toString();
    const newPassword = (req.body?.newPassword || '').toString();
    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters.' });
    }

    const admins = await getAdminsCollection();
    const admin = await admins.findOne({ username: session.username });
    if (!admin) {
      return res.status(404).json({ error: 'Admin account not found.' });
    }
    if (!verifyPassword(currentPassword, admin.passwordHash)) {
      return res.status(401).json({ error: 'Current password is incorrect.' });
    }

    await admins.updateOne(
      { _id: admin._id },
      { $set: { passwordHash: await hashPassword(newPassword), updatedAt: new Date() } },
    );
    return res.json({ updated: true, username: session.username });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to change password', details: error.message });
  }
});

app.get('/api/messages', async (req, res) => {
  try {
    const collection = await getMessagesCollection();
    const section = (req.query.section || 'all').toString().trim();
    const group = (req.query.group || 'all').toString().trim();
    const search = (req.query.search || req.query.q || '').toString().trim();
    const pinnedOnly = String(req.query.pinned || '').toLowerCase() === 'true';

    let limit = Number.parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 20;
    if (limit > 100) limit = 100;

    const beforeCursorRaw = (req.query.before || req.query.beforeCursor || '').toString().trim();
    const afterCursorRaw = (req.query.after || req.query.afterCursor || '').toString().trim();
    const includeTotal = String(req.query.total || '').toLowerCase() === 'true';

    const query = {};
    if (section !== 'all' && section.length > 0) {
      query.section = section;
    }
    if (group !== 'all' && group.length > 0) {
      query.targetGroup = { $in: ['all', group] };
    }
    if (pinnedOnly) {
      query.pinned = true;
    }
    if (search) {
      query.text = { $regex: escapeRegex(search), $options: 'i' };
    }

    let cursorDate = null;
    let cursorId = null;
    const activeCursor = beforeCursorRaw || afterCursorRaw;
    if (activeCursor) {
      const [datePart, idPart] = activeCursor.split('|');
      cursorDate = datePart ? new Date(datePart) : null;
      cursorId = idPart && ObjectId.isValid(idPart) ? new ObjectId(idPart) : null;
      if (cursorDate && Number.isNaN(cursorDate.getTime())) cursorDate = null;
    }

    const isAfter = Boolean(afterCursorRaw);
    if (cursorDate && cursorId) {
      const compareOp = isAfter ? '$gt' : '$lt';
      query.createdAt = { [compareOp]: cursorDate };
      query._id = { [compareOp]: cursorId };
    }

    const docs = await collection
      .find(query)
      .sort(isAfter ? { createdAt: 1, _id: 1 } : { createdAt: -1, _id: -1 })
      .limit(limit)
      .toArray();

    const messages = docs.map(serializeMessage);

    if (isAfter) {
      messages.sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
    }

    let total = null;
    if (includeTotal) {
      const { createdAt: _c, _id: _i, ...countQuery } = query;
      total = await collection.countDocuments(countQuery);
    }

    // messages are sorted newest-first (desc) except when paginating forward (after).
    // For a desc page: messages[0] = newest, messages[last] = oldest.
    // nextBefore lets the client load the NEXT OLDER page -> cursor at the oldest item.
    // nextAfter lets the client poll for NEW items -> cursor at the newest item.
    const newestMsg = isAfter ? messages[messages.length - 1] : messages[0];
    const oldestMsg = isAfter ? messages[0] : messages[messages.length - 1];
    const nextBefore = messages.length === limit && oldestMsg
      ? `${oldestMsg.createdAt}|${oldestMsg.id}`
      : null;
    const nextAfter = newestMsg
      ? `${newestMsg.createdAt}|${newestMsg.id}`
      : null;

    res.json({ messages, hasMore: messages.length === limit, nextBefore, nextAfter, total });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load messages', details: error.message });
  }
});

app.get('/api/media/:id', async (req, res) => {
  try {
    await ensureMongoReady();

    const fileId = req.params.id;
    if (!ObjectId.isValid(fileId)) {
      return res.status(400).json({ error: 'Invalid media id.' });
    }

    const objectId = new ObjectId(fileId);
    const files = await _gridFs.find({ _id: objectId }).limit(1).toArray();
    if (!files.length) {
      return res.status(404).json({ error: 'Media not found.' });
    }

    const file = files[0];
    res.setHeader('Content-Type', file.contentType || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

    const stream = _gridFs.openDownloadStream(objectId);
    stream.on('error', (error) => {
      if (!res.headersSent) {
        res.status(500).json({ error: 'Could not stream media', details: error.message });
      } else {
        res.end();
      }
    });

    return stream.pipe(res);
  } catch (error) {
    return res.status(500).json({ error: 'Failed to load media', details: error.message });
  }
});

app.post('/api/admin/upload', upload.single('media'), async (req, res) => {
  const _admin = await requireAdmin(req, res); if (!_admin) return;

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded. Use form-data key: media' });
  }

  try {
    const originalName = req.file.originalname || 'media';
    const safeExt = path.extname(originalName || '').replace(/[^.a-zA-Z0-9]/g, '') || '';
    const fileName = `${Date.now()}-${crypto.randomUUID()}${safeExt}`;
    const fileId = await saveMediaToGridFs({
      buffer: req.file.buffer,
      filename: fileName,
      mimeType: req.file.mimetype,
    });

    const mediaUrl = `${resolvePublicBaseUrl(req)}/api/media/${fileId.toString()}`;
    const mediaType = detectMediaType(req.file.mimetype || '');

    return res.json({
      mediaUrl,
      mediaId: fileId.toString(),
      mediaType,
      mimeType: req.file.mimetype,
      fileName,
      originalName,
      size: req.file.size,
    });
  } catch (error) {
    return res.status(500).json({ error: 'Media upload failed', details: error.message });
  }
});

// Delete an uploaded media file (admin only).
app.delete('/api/admin/media/:id', async (req, res) => {
  const _admin = await requireAdmin(req, res); if (!_admin) return;
  try {
    const fileId = req.params.id;
    if (!ObjectId.isValid(fileId)) {
      return res.status(400).json({ error: 'Invalid media id.' });
    }
    const deleted = await deleteGridFsById(fileId);
    if (!deleted) {
      return res.status(404).json({ error: 'Media not found.' });
    }
    return res.json({ deleted: true, id: fileId });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to delete media', details: error.message });
  }
});

// List uploaded media files (admin only).
app.get('/api/admin/media', async (req, res) => {
  const _admin = await requireAdmin(req, res); if (!_admin) return;
  try {
    await ensureMongoReady();
    let limit = Number.parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 50;
    if (limit > 200) limit = 200;

    const files = await _gridFs.find().sort({ uploadDate: -1 }).limit(limit).toArray();
    const items = files.map((f) => ({
      id: f._id.toString(),
      filename: f.filename,
      contentType: f.contentType,
      length: f.length,
      uploadDate: f.uploadDate instanceof Date ? f.uploadDate.toISOString() : new Date(f.uploadDate).toISOString(),
      url: `${resolvePublicBaseUrl(req)}/api/media/${f._id.toString()}`,
      mediaType: detectMediaType(f.contentType || ''),
    }));
    return res.json({ media: items, count: items.length });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to list media', details: error.message });
  }
});

app.post('/api/admin/messages', async (req, res) => {
  const _admin = await requireAdmin(req, res); if (!_admin) return;

  const text = (req.body?.text || '').toString().trim();
  const mediaUrl = (req.body?.mediaUrl || '').toString().trim();
  const mediaType = (req.body?.mediaType || '').toString().trim();
  const section = (req.body?.section || 'general').toString().trim() || 'general';
  const targetGroup = (req.body?.targetGroup || req.body?.target || 'all').toString().trim() || 'all';
  const senderName = (req.body?.senderName || 'Admin').toString().trim() || 'Admin';
  const pinned = Boolean(req.body?.pinned);

  if (!text && !mediaUrl) {
    return res.status(400).json({ error: 'Either text or mediaUrl is required' });
  }

  const supportedTypes = new Set(['image', 'video', 'audio', 'file', '']);
  if (!supportedTypes.has(mediaType)) {
    return res.status(400).json({ error: 'mediaType must be image|video|audio|file' });
  }

  if (!isKnownSection(section)) {
    return res.status(400).json({ error: `Invalid section. Allowed: ${NOTICE_SECTIONS.map((x) => x.key).join(', ')}` });
  }

  if (!isKnownGroup(targetGroup)) {
    return res.status(400).json({ error: `Invalid targetGroup. Allowed: ${TARGET_GROUPS.map((x) => x.key).join(', ')}` });
  }

  const now = new Date();
  const message = {
    text,
    mediaUrl,
    mediaType: mediaType || (mediaUrl ? 'file' : 'text'),
    senderRole: 'admin',
    senderName,
    section,
    targetGroup,
    pinned,
    createdAt: now,
    updatedAt: now,
  };

  try {
    const collection = await getMessagesCollection();
    const result = await collection.insertOne(message);
    const saved = await collection.findOne({ _id: result.insertedId });
    return res.status(201).json({ message: serializeMessage(saved) });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to save message', details: error.message });
  }
});

// Get a single message by id (admin only).
app.get('/api/admin/messages/:id', async (req, res) => {
  const _admin = await requireAdmin(req, res); if (!_admin) return;
  try {
    const collection = await getMessagesCollection();
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid message id.' });
    }
    const doc = await collection.findOne({ _id: new ObjectId(req.params.id) });
    if (!doc) {
      return res.status(404).json({ error: 'Message not found.' });
    }
    return res.json({ message: serializeMessage(doc) });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to load message', details: error.message });
  }
});

// Edit an existing message (admin only).
app.patch('/api/admin/messages/:id', async (req, res) => {
  const _admin = await requireAdmin(req, res); if (!_admin) return;
  try {
    const collection = await getMessagesCollection();
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid message id.' });
    }
    const objectId = new ObjectId(req.params.id);
    const existing = await collection.findOne({ _id: objectId });
    if (!existing) {
      return res.status(404).json({ error: 'Message not found.' });
    }

    const updates = {};
    const body = req.body || {};

    const text = (body.text ?? '').toString().trim();
    if (body.text !== undefined) {
      if (!text && !(body.mediaUrl ?? existing.mediaUrl)) {
        return res.status(400).json({ error: 'Either text or mediaUrl is required' });
      }
      updates.text = text;
    }

    const incomingMediaUrl = (body.mediaUrl ?? '').toString().trim();
    if (body.mediaUrl !== undefined) {
      updates.mediaUrl = incomingMediaUrl;
      updates.mediaType = (body.mediaType ?? '').toString().trim()
        || (incomingMediaUrl ? detectMediaTypeFromUrl(incomingMediaUrl) : 'text');
    } else if (body.mediaType !== undefined) {
      const mt = (body.mediaType ?? '').toString().trim();
      if (!new Set(['image', 'video', 'audio', 'file', 'text', '']).has(mt)) {
        return res.status(400).json({ error: 'mediaType must be image|video|audio|file|text' });
      }
      updates.mediaType = mt || (updates.mediaUrl || existing.mediaUrl ? 'file' : 'text');
    }

    if (body.section !== undefined) {
      const section = (body.section ?? 'general').toString().trim() || 'general';
      if (!isKnownSection(section)) {
        return res.status(400).json({ error: `Invalid section. Allowed: ${NOTICE_SECTIONS.map((x) => x.key).join(', ')}` });
      }
      updates.section = section;
    }
    if (body.targetGroup !== undefined) {
      const targetGroup = (body.targetGroup ?? body.target ?? 'all').toString().trim() || 'all';
      if (!isKnownGroup(targetGroup)) {
        return res.status(400).json({ error: `Invalid targetGroup. Allowed: ${TARGET_GROUPS.map((x) => x.key).join(', ')}` });
      }
      updates.targetGroup = targetGroup;
    }
    if (body.senderName !== undefined) {
      updates.senderName = (body.senderName ?? 'Admin').toString().trim() || 'Admin';
    }
    if (body.pinned !== undefined) {
      updates.pinned = Boolean(body.pinned);
    }

    // If media is being replaced/removed, clean up the old GridFS file.
    if (updates.mediaUrl !== undefined && updates.mediaUrl !== existing.mediaUrl) {
      const oldMediaId = extractMediaIdFromUrl(existing.mediaUrl);
      if (oldMediaId) {
        await deleteGridFsById(oldMediaId).catch(() => {});
      }
    }

    if (Object.keys(updates).length === 0) {
      return res.json({ message: serializeMessage(existing) });
    }

    updates.updatedAt = new Date();
    await collection.updateOne({ _id: objectId }, { $set: updates });
    const updated = await collection.findOne({ _id: objectId });
    return res.json({ message: serializeMessage(updated) });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to update message', details: error.message });
  }
});

// Delete a single message by id (admin only). Also removes its GridFS media.
app.delete('/api/admin/messages/:id', async (req, res) => {
  const _admin = await requireAdmin(req, res); if (!_admin) return;
  try {
    const collection = await getMessagesCollection();
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid message id.' });
    }
    const objectId = new ObjectId(req.params.id);
    const existing = await collection.findOne({ _id: objectId });
    if (!existing) {
      return res.status(404).json({ error: 'Message not found.' });
    }

    const mediaId = extractMediaIdFromUrl(existing.mediaUrl);
    const result = await collection.deleteOne({ _id: objectId });
    if (mediaId) {
      await deleteGridFsById(mediaId).catch(() => {});
    }
    return res.json({ deleted: true, id: req.params.id, removed: result.deletedCount });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to delete message', details: error.message });
  }
});

// Bulk delete messages by ids (admin only).
app.delete('/api/admin/messages', async (req, res) => {
  const _admin = await requireAdmin(req, res); if (!_admin) return;
  try {
    const collection = await getMessagesCollection();
    const rawIds = Array.isArray(req.body?.ids) ? req.body.ids : [];
    const ids = rawIds
      .map((id) => String(id).trim())
      .filter((id) => ObjectId.isValid(id))
      .map((id) => new ObjectId(id));

    if (!ids.length) {
      return res.status(400).json({ error: 'No valid ids provided in "ids" array.' });
    }

    const targets = await collection.find({ _id: { $in: ids } }).toArray();
    const mediaIds = targets
      .map((t) => extractMediaIdFromUrl(t.mediaUrl))
      .filter(Boolean);

    const result = await collection.deleteMany({ _id: { $in: ids } });
    await Promise.all(mediaIds.map((mid) => deleteGridFsById(mid).catch(() => {})));

    return res.json({
      deleted: result.deletedCount,
      requested: ids.length,
      mediaRemoved: mediaIds.length,
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to bulk delete messages', details: error.message });
  }
});

function detectMediaTypeFromUrl(url) {
  const ext = path.extname(url || '').toLowerCase();
  const imageExt = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.svg'];
  const videoExt = ['.mp4', '.mov', '.avi', '.mkv', '.webm', '.m4v'];
  const audioExt = ['.mp3', '.wav', '.aac', '.m4a', '.ogg', '.flac'];
  if (imageExt.includes(ext)) return 'image';
  if (videoExt.includes(ext)) return 'video';
  if (audioExt.includes(ext)) return 'audio';
  return 'file';
}

function serializeResource(doc) {
  if (!doc) return null;
  return {
    id: doc._id.toString(),
    title: doc.title || '',
    description: doc.description || '',
    category: doc.category || 'other',
    mediaUrl: doc.mediaUrl || '',
    mediaType: doc.mediaType || 'file',
    fileSize: doc.fileSize || 0,
    fileName: doc.fileName || '',
    mimeType: doc.mimeType || '',
    uploaderUid: doc.uploaderUid || '',
    uploaderEmail: doc.uploaderEmail || '',
    uploaderName: doc.uploaderName || '',
    source: doc.source || 'user',
    createdAt: (doc.createdAt instanceof Date ? doc.createdAt : new Date(doc.createdAt || Date.now())).toISOString(),
    updatedAt: doc.updatedAt
      ? (doc.updatedAt instanceof Date ? doc.updatedAt : new Date(doc.updatedAt)).toISOString()
      : null,
  };
}

// Public paginated list of resources.
app.get('/api/resources', async (req, res) => {
  try {
    const collection = await getResourcesCollection();
    const category = (req.query.category || 'all').toString().trim();
    const uploaderUid = (req.query.uploaderUid || '').toString().trim();
    const search = (req.query.search || req.query.q || '').toString().trim();

    let limit = Number.parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 20;
    if (limit > 100) limit = 100;

    const beforeCursorRaw = (req.query.before || '').toString().trim();
    const includeTotal = String(req.query.total || '').toLowerCase() === 'true';

    const query = {};
    if (category !== 'all' && category.length > 0) {
      query.category = category;
    }
    if (uploaderUid) {
      query.uploaderUid = uploaderUid;
    }
    if (search) {
      query.$or = [
        { title: { $regex: escapeRegex(search), $options: 'i' } },
        { description: { $regex: escapeRegex(search), $options: 'i' } },
      ];
    }

    if (beforeCursorRaw) {
      const [datePart, idPart] = beforeCursorRaw.split('|');
      const cursorDate = datePart ? new Date(datePart) : null;
      const cursorId = idPart && ObjectId.isValid(idPart) ? new ObjectId(idPart) : null;
      if (cursorDate && cursorId && !Number.isNaN(cursorDate.getTime())) {
        query.createdAt = { $lt: cursorDate };
        query._id = { $lt: cursorId };
      }
    }

    const docs = await collection
      .find(query)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .toArray();

    const resources = docs.map(serializeResource);

    let total = null;
    if (includeTotal) {
      const { createdAt: _c, _id: _i, ...countQuery } = query;
      total = await collection.countDocuments(countQuery);
    }

    const oldest = resources[resources.length - 1];
    const newest = resources[0];
    const nextBefore = resources.length === limit && oldest
      ? `${oldest.createdAt}|${oldest.id}`
      : null;
    const nextAfter = newest ? `${newest.createdAt}|${newest.id}` : null;

    res.json({ resources, hasMore: resources.length === limit, nextBefore, nextAfter, total });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load resources', details: error.message });
  }
});

// Public single resource.
app.get('/api/resources/:id', async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid resource id.' });
    }
    const collection = await getResourcesCollection();
    const doc = await collection.findOne({ _id: new ObjectId(req.params.id) });
    if (!doc) return res.status(404).json({ error: 'Resource not found.' });
    return res.json({ resource: serializeResource(doc) });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to load resource', details: error.message });
  }
});

// User uploads a resource (requires Firebase idToken).
app.post('/api/resources', upload.single('file'), async (req, res) => {
  let user;
  try {
    const idToken = (req.headers['x-user-token'] || '').toString().trim();
    user = await verifyFirebaseUser(idToken);
  } catch (error) {
    return res.status(401).json({ error: 'Invalid or missing user token.', details: error.message });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded. Use form-data key: file' });
  }

  const title = (req.body?.title || '').toString().trim();
  const description = (req.body?.description || '').toString().trim();
  const category = (req.body?.category || 'other').toString().trim() || 'other';

  if (!title) {
    return res.status(400).json({ error: 'Title is required.' });
  }
  if (!isKnownCategory(category)) {
    return res.status(400).json({ error: `Invalid category. Allowed: ${RESOURCE_CATEGORIES.map((x) => x.key).join(', ')}` });
  }

  try {
    const safeExt = path.extname(req.file.originalname || '').replace(/[^.a-zA-Z0-9]/g, '') || '';
    const fileName = `${Date.now()}-${crypto.randomUUID()}${safeExt}`;
    const fileId = await saveMediaToGridFs({
      buffer: req.file.buffer,
      filename: fileName,
      mimeType: req.file.mimetype,
      source: 'user-resource',
    });
    const mediaUrl = `${resolvePublicBaseUrl(req)}/api/media/${fileId.toString()}`;

    const now = new Date();
    const resource = {
      title,
      description,
      category,
      mediaUrl,
      mediaType: detectMediaType(req.file.mimetype || ''),
      fileSize: req.file.size,
      fileName: req.file.originalname || fileName,
      mimeType: req.file.mimetype || '',
      uploaderUid: user.uid,
      uploaderEmail: user.email,
      uploaderName: user.name || user.email || 'User',
      source: 'user',
      createdAt: now,
      updatedAt: now,
    };

    const collection = await getResourcesCollection();
    const result = await collection.insertOne(resource);
    const saved = await collection.findOne({ _id: result.insertedId });
    return res.status(201).json({ resource: serializeResource(saved) });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to upload resource', details: error.message });
  }
});

// Delete a resource: admin OR the owner.
app.delete('/api/resources/:id', async (req, res) => {
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid resource id.' });
    }
    const objectId = new ObjectId(req.params.id);
    const collection = await getResourcesCollection();
    const existing = await collection.findOne({ _id: objectId });
    if (!existing) {
      return res.status(404).json({ error: 'Resource not found.' });
    }

    // Authorization: admin session OR owner via Firebase idToken.
    const admin = await resolveAdminRequest(req);
    if (!admin) {
      try {
        const idToken = (req.headers['x-user-token'] || '').toString().trim();
        const user = await verifyFirebaseUser(idToken);
        if (!user || user.uid !== existing.uploaderUid) {
          return res.status(403).json({ error: 'You can only delete your own resources.' });
        }
      } catch (error) {
        return res.status(401).json({ error: 'Authentication required to delete this resource.', details: error.message });
      }
    }

    const mediaId = extractMediaIdFromUrl(existing.mediaUrl);
    const result = await collection.deleteOne({ _id: objectId });
    if (mediaId) await deleteGridFsById(mediaId).catch(() => {});
    return res.json({ deleted: true, id: req.params.id, removed: result.deletedCount });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to delete resource', details: error.message });
  }
});

// Admin uploads a resource (admin session).
app.post('/api/admin/resources', upload.single('file'), async (req, res) => {
  const admin = await requireAdminSession(req, res);
  if (!admin) return;

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded. Use form-data key: file' });
  }

  const title = (req.body?.title || '').toString().trim();
  const description = (req.body?.description || '').toString().trim();
  const category = (req.body?.category || 'other').toString().trim() || 'other';
  const uploaderName = (req.body?.uploaderName || 'Admin').toString().trim() || 'Admin';

  if (!title) {
    return res.status(400).json({ error: 'Title is required.' });
  }
  if (!isKnownCategory(category)) {
    return res.status(400).json({ error: `Invalid category. Allowed: ${RESOURCE_CATEGORIES.map((x) => x.key).join(', ')}` });
  }

  try {
    const safeExt = path.extname(req.file.originalname || '').replace(/[^.a-zA-Z0-9]/g, '') || '';
    const fileName = `${Date.now()}-${crypto.randomUUID()}${safeExt}`;
    const fileId = await saveMediaToGridFs({
      buffer: req.file.buffer,
      filename: fileName,
      mimeType: req.file.mimetype,
      source: 'admin-resource',
    });
    const mediaUrl = `${resolvePublicBaseUrl(req)}/api/media/${fileId.toString()}`;

    const now = new Date();
    const resource = {
      title,
      description,
      category,
      mediaUrl,
      mediaType: detectMediaType(req.file.mimetype || ''),
      fileSize: req.file.size,
      fileName: req.file.originalname || fileName,
      mimeType: req.file.mimetype || '',
      uploaderUid: '',
      uploaderEmail: '',
      uploaderName,
      source: 'admin',
      createdAt: now,
      updatedAt: now,
    };

    const collection = await getResourcesCollection();
    const result = await collection.insertOne(resource);
    const saved = await collection.findOne({ _id: result.insertedId });
    return res.status(201).json({ resource: serializeResource(saved) });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to upload resource', details: error.message });
  }
});

// Admin lists ALL resources (with uploader info).
app.get('/api/admin/resources', async (req, res) => {
  const admin = await requireAdminSession(req, res);
  if (!admin) return;
  try {
    const collection = await getResourcesCollection();
    const category = (req.query.category || 'all').toString().trim();
    const search = (req.query.search || req.query.q || '').toString().trim();

    let limit = Number.parseInt(req.query.limit, 10);
    if (!Number.isFinite(limit) || limit <= 0) limit = 50;
    if (limit > 200) limit = 200;
    const beforeCursorRaw = (req.query.before || '').toString().trim();
    const includeTotal = String(req.query.total || '').toLowerCase() === 'true';

    const query = {};
    if (category !== 'all' && category.length > 0) query.category = category;
    if (search) {
      query.$or = [
        { title: { $regex: escapeRegex(search), $options: 'i' } },
        { description: { $regex: escapeRegex(search), $options: 'i' } },
      ];
    }
    if (beforeCursorRaw) {
      const [datePart, idPart] = beforeCursorRaw.split('|');
      const cursorDate = datePart ? new Date(datePart) : null;
      const cursorId = idPart && ObjectId.isValid(idPart) ? new ObjectId(idPart) : null;
      if (cursorDate && cursorId && !Number.isNaN(cursorDate.getTime())) {
        query.createdAt = { $lt: cursorDate };
        query._id = { $lt: cursorId };
      }
    }

    const docs = await collection
      .find(query)
      .sort({ createdAt: -1, _id: -1 })
      .limit(limit)
      .toArray();

    const resources = docs.map(serializeResource);
    let total = null;
    if (includeTotal) {
      const { createdAt: _c, _id: _i, ...countQuery } = query;
      total = await collection.countDocuments(countQuery);
    }
    const oldest = resources[resources.length - 1];
    const nextBefore = resources.length === limit && oldest ? `${oldest.createdAt}|${oldest.id}` : null;
    res.json({ resources, hasMore: resources.length === limit, nextBefore, total });
  } catch (error) {
    res.status(500).json({ error: 'Failed to list resources', details: error.message });
  }
});

// Admin deletes any resource.
app.delete('/api/admin/resources/:id', async (req, res) => {
  const admin = await requireAdminSession(req, res);
  if (!admin) return;
  try {
    if (!ObjectId.isValid(req.params.id)) {
      return res.status(400).json({ error: 'Invalid resource id.' });
    }
    const objectId = new ObjectId(req.params.id);
    const collection = await getResourcesCollection();
    const existing = await collection.findOne({ _id: objectId });
    if (!existing) {
      return res.status(404).json({ error: 'Resource not found.' });
    }
    const mediaId = extractMediaIdFromUrl(existing.mediaUrl);
    const result = await collection.deleteOne({ _id: objectId });
    if (mediaId) await deleteGridFsById(mediaId).catch(() => {});
    return res.json({ deleted: true, id: req.params.id, removed: result.deletedCount });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to delete resource', details: error.message });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    const startupBase = BASE_URL || `http://localhost:${PORT}`;
    console.log(`Chat backend running on ${startupBase}`);
  });
  ensureMongoReady().then(() => {
    console.log('Database ready');
  }).catch((error) => {
    console.error('Database startup error:', error.message);
  });
}

module.exports = app;
