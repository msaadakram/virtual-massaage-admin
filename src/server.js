const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');

const express = require('express');
const cors = require('cors');
const multer = require('multer');
const dotenv = require('dotenv');

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ADMIN_TOKEN = (process.env.ADMIN_TOKEN || '').trim() || 'change-me-admin-token';
const BASE_URL = (process.env.BASE_URL || '').trim();
const IS_VERCEL = Boolean(process.env.VERCEL);

const DATA_DIR = IS_VERCEL
  ? '/tmp'
  : path.resolve(__dirname, '../data');
const DATA_FILE = IS_VERCEL
  ? path.join('/tmp', 'messages.json')
  : path.join(DATA_DIR, 'messages.json');
const UPLOADS_DIR = path.resolve(__dirname, '../uploads');
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
app.use('/uploads', express.static(UPLOADS_DIR));
app.use('/admin-assets', express.static(PUBLIC_DIR));

function isKnownSection(value) {
  return NOTICE_SECTIONS.some((item) => item.key === value);
}

function isKnownGroup(value) {
  return TARGET_GROUPS.some((item) => item.key === value);
}

const storage = multer.diskStorage({
  destination: async (_req, _file, cb) => {
    try {
      await fs.mkdir(UPLOADS_DIR, { recursive: true });
      cb(null, UPLOADS_DIR);
    } catch (error) {
      cb(error);
    }
  },
  filename: (_req, file, cb) => {
    const safeExt = path.extname(file.originalname || '').replace(/[^.a-zA-Z0-9]/g, '') || '';
    cb(null, `${Date.now()}-${crypto.randomUUID()}${safeExt}`);
  },
});

const upload = multer({
  storage,
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

async function readMessages() {
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    const raw = await fs.readFile(DATA_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if (error.code === 'ENOENT') {
      await fs.writeFile(DATA_FILE, '[]\n', 'utf8');
      return [];
    }
    throw error;
  }
}

async function writeMessages(messages) {
  await fs.mkdir(DATA_DIR, { recursive: true });
  await fs.writeFile(DATA_FILE, `${JSON.stringify(messages, null, 2)}\n`, 'utf8');
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'chat-backend',
    runtime: IS_VERCEL ? 'vercel' : 'node',
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
    const messages = await readMessages();
    const section = (req.query.section || 'all').toString().trim();
    const group = (req.query.group || 'all').toString().trim();

    const filtered = messages.filter((item) => {
      const sectionMatches =
        section === 'all' ||
        section.length === 0 ||
        (item.section || 'general') === section;

      const messageGroup = (item.targetGroup || 'all').toString();
      const groupMatches =
        group === 'all' ||
        group.length === 0 ||
        messageGroup === 'all' ||
        messageGroup === group;

      return sectionMatches && groupMatches;
    });

    filtered.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    res.json({ messages: filtered });
  } catch (error) {
    res.status(500).json({ error: 'Failed to load messages', details: error.message });
  }
});

app.post('/api/admin/upload', upload.single('media'), async (req, res) => {
  if (!isAdmin(req)) {
    return res.status(403).json({ error: 'Admin token is invalid' });
  }

  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded. Use form-data key: media' });
  }

  const mediaUrl = `${resolvePublicBaseUrl(req)}/uploads/${req.file.filename}`;
  const mediaType = detectMediaType(req.file.mimetype || '');

  return res.json({
    mediaUrl,
    mediaType,
    mimeType: req.file.mimetype,
    fileName: req.file.filename,
    originalName: req.file.originalname,
    size: req.file.size,
  });
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
    id: crypto.randomUUID(),
    text,
    mediaUrl,
    mediaType: mediaType || (mediaUrl ? 'file' : 'text'),
    senderRole: 'admin',
    senderName,
    section,
    targetGroup,
    createdAt: new Date().toISOString(),
  };

  try {
    const messages = await readMessages();
    messages.push(message);
    await writeMessages(messages);
    return res.status(201).json({ message });
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
