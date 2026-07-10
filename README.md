# Chat Backend (Admin-only)

This backend replaces Firebase chat and keeps **Firebase only for login** in the Flutter app.

## Features
- Admin dashboard UI at `/admin`
- Notice sections: `notice-board`, `website-issues`, `exam-rules`, `date-sheet`, `paid-project`, `jobs`, `vu-notice`, `learning-notice`, `general`
- Target groups: `all`, `bscs`, `bsit`, `mcs`, `mba`, `paid-project-team`
- Messages are stored in MongoDB collection: `messages`
- Media files are stored in MongoDB GridFS bucket: `media` (`media.files` / `media.chunks`)
- `GET /api/messages`: app reads messages/media with cursor pagination
  - Query params: `section`, `group`, `limit` (default 20, max 100), `before` (cursor for older page), `after` (cursor for newer page), `total=true` (include total count), `search` (case-insensitive text search), `pinned=true`
  - Returns `{ messages, hasMore, nextBefore, nextAfter, total }`. Cursor format: `createdAt|_id`.
- `GET /api/meta`: sections and groups metadata
- `GET /api/media/:id`: streams uploaded media from GridFS
- `POST /api/admin/upload`: admin uploads media (`multipart/form-data`, key `media`)
- `POST /api/admin/messages`: admin sends text/media messages with section + target group (+ `pinned`)
- `GET /api/admin/messages/:id`: fetch a single message (admin only)
- `PATCH /api/admin/messages/:id`: edit a message (text, mediaUrl, mediaType, section, targetGroup, senderName, pinned). Replacing/removing media also deletes the old GridFS file.
- `DELETE /api/admin/messages/:id`: delete a message and its GridFS media
- `DELETE /api/admin/messages`: bulk delete by `{ ids: [...] }`; removes each message's media too
- `GET /api/admin/media`: list uploaded media files (admin only)
- `DELETE /api/admin/media/:id`: delete an orphaned media file (admin only)
- `x-admin-token` header protects all `/api/admin/*` routes

## Environment
The backend reads env values from the project root `.env` file.

Required:
- `PORT`
- `BASE_URL`
- `ADMIN_TOKEN`
- `MONGODB_URI`
- `MONGODB_DB_NAME` (set to `vu-chat-app`)

## Quick start
1. Install dependencies in `backend/`
2. Run backend in `backend/`
3. Open admin UI: `http://localhost:3000/admin`
4. In Flutter app, set `--dart-define=CHAT_BACKEND_URL=<your-backend-url>`

## Push only backend folder to GitHub
Run these commands from inside `backend/`:

1. `git init`
2. `git add .`
3. `git commit -m "Initial backend admin panel and API"`
4. `git branch -M main`
5. `git remote add origin git@github.com:msaadakram/virtual-massaage-admin.git`
6. `git push -u origin main`

## Deploy on Vercel

This backend is configured with `vercel.json`.

1. Import this repository in Vercel
2. Root directory: `.` (repository root is backend-only if you pushed only backend)
3. Framework preset: **Other**
4. Add environment variables in Vercel project settings:
	- `ADMIN_TOKEN`
	- `BASE_URL` (optional; can be left empty to auto-detect)
	- `MONGODB_URI`
	- `MONGODB_DB_NAME` (`vu-chat-app`)
5. Deploy

After deployment, admin panel will be available at:
- `https://<your-vercel-domain>/admin`

## MongoDB storage design

- Database name: `vu-chat-app`
- Messages collection: `messages`
- GridFS media bucket: `media`

This provides persistent storage on local and Vercel deployments.

## Admin flow
1. Open `/admin`
2. Enter `Admin Token`
3. Choose section and target group
4. Write message and optionally upload media
5. Click **Send Notice**

## API examples

### Send text/media notice
`POST /api/admin/messages`

Body fields:
- `text` (optional if media exists)
- `mediaUrl` (optional)
- `mediaType` (`image|video|audio|file` or empty)
- `section` (`paid-project|vu-notice|learning-notice|general`)
- `section` (`notice-board|website-issues|exam-rules|date-sheet|paid-project|jobs|vu-notice|learning-notice|general`)
- `targetGroup` (`all|bscs|bsit|mcs|mba|paid-project-team`)
- `senderName` (optional)
