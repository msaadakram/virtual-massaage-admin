const path = require('path');
const crypto = require('crypto');

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const dotenv = require('dotenv');
const { MongoClient, GridFSBucket, ObjectId } = require('mongodb');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || '').trim() || 'change-me-admin-token';
const BASE_URL = (process.env.BASE_URL || '').trim();
const IS_VERCEL = Boolean(process.env.VERCEL);
const MONGODB_URI = (process.env.MONGODB_URI || '').trim();
const MONGODB_DB_NAME = (process.env.MONGODB_DB_NAME || 'vu-chat-app').trim() || 'vu-chat-app';

const PUBLIC_DIR = path.resolve(__dirname, '../public');

const NOTICE_SECTIONS = [
  { key: 'all', label: 'All Notices' },
  { key: 'paid-project', label: 'Paid Project' },
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
        serverSelectionTimeoutMS: 10000,
      });
      await _mongoClient.connect();
    }

    _mongoDb = _mongoClient.db(MONGODB_DB_NAME);
    _gridFs = new GridFSBucket(_mongoDb, { bucketName: 'media' });

    await _mongoDb.collection('messages').createIndex({ createdAt: 1 });
    await _mongoDb.collection('messages').createIndex({ section: 1, targetGroup: 1, createdAt: 1 });
  })();

  return _mongoReadyPromise;
}

async function getMessagesCollection() {
  await ensureMongoReady();
  return _mongoDb.collection('messages');
}

async function saveMediaToGridFs({ buffer, filename, mimeType }) {
  await ensureMongoReady();

  const uploadStream = _gridFs.openUploadStream(filename, {
    contentType: mimeType,
    metadata: {
      createdAt: new Date(),
      source: 'admin-upload',
    },
  });

  await new Promise((resolve, reject) => {
    uploadStream.once('error', reject);
    uploadStream.once('finish', resolve);
    uploadStream.end(buffer);
  });

  return uploadStream.id;
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

function isAdmin(req) {
  const token = (req.headers['x-admin-token'] || '').toString().trim();
  return token.length > 0 && token === ADMIN_TOKEN;
}

function detectMediaType(mimeType = '') {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'file';
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
  });
});

app.get('/api/messages', async (req, res) => {
  try {
    const collection = await getMessagesCollection();
    const section = (req.query.section || 'all').toString().trim();
    const group = (req.query.group || 'all').toString().trim();

    const query = {};
    if (section !== 'all' && section.length > 0) {
      query.section = section;
    }
    if (group !== 'all' && group.length > 0) {
      query.$or = [{ targetGroup: 'all' }, { targetGroup: group }];
    }

    const docs = await collection
      .find(query)
      .sort({ createdAt: 1 })
      .limit(500)
      .toArray();

    const messages = docs.map((doc) => ({
      id: doc._id.toString(),
      text: doc.text || '',
      mediaUrl: doc.mediaUrl || '',
      mediaType: doc.mediaType || 'text',
      senderRole: doc.senderRole || 'admin',
      senderName: doc.senderName || 'Admin',
      section: doc.section || 'general',
      targetGroup: doc.targetGroup || 'all',
      createdAt: (doc.createdAt instanceof Date ? doc.createdAt : new Date(doc.createdAt)).toISOString(),
    }));

    res.json({ messages });
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
  if (!isAdmin(req)) {
    return res.status(403).json({ error: 'Admin token is invalid' });
  }

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

app.post('/api/admin/messages', async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ error: 'Admin token is invalid' });
  }

  const text = (req.body?.text || '').toString().trim();
  const mediaUrl = (req.body?.mediaUrl || '').toString().trim();
  const mediaType = (req.body?.mediaType || '').toString().trim();
  const section = (req.body?.section || 'general').toString().trim() || 'general';
  const targetGroup = (req.body?.targetGroup || req.body?.target || 'all').toString().trim() || 'all';
  const senderName = (req.body?.senderName || 'Admin').toString().trim() || 'Admin';

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

  const message = {
    text,
    mediaUrl,
    mediaType: mediaType || (mediaUrl ? 'file' : 'text'),
    senderRole: 'admin',
    senderName,
    section,
    targetGroup,
    createdAt: new Date(),
  };

  try {
    const collection = await getMessagesCollection();
    const result = await collection.insertOne(message);

    return res.status(201).json({
      message: {
        id: result.insertedId.toString(),
        text: message.text,
        mediaUrl: message.mediaUrl,
        mediaType: message.mediaType,
        senderRole: message.senderRole,
        senderName: message.senderName,
        section: message.section,
        targetGroup: message.targetGroup,
        createdAt: message.createdAt.toISOString(),
      },
    });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to save message', details: error.message });
  }
});

if (require.main === module) {
  app.listen(PORT, () => {
    const startupBase = BASE_URL || `http://localhost:${PORT}`;
    console.log(`Chat backend running on ${startupBase}`);
  });
}

module.exports = app;
