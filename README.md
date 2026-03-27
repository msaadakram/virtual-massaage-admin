# Chat Backend (Admin-only)

This backend replaces Firebase chat and keeps **Firebase only for login** in the Flutter app.

## Features
- Admin dashboard UI at `/admin`
- Notice sections: `paid-project`, `vu-notice`, `learning-notice`, `general`
- Target groups: `all`, `bscs`, `bsit`, `mcs`, `mba`, `paid-project-team`
- `GET /api/messages`: app reads messages/media (supports `section` and `group` filters)
- `GET /api/meta`: sections and groups metadata
- `POST /api/admin/upload`: admin uploads media (`multipart/form-data`, key `media`)
- `POST /api/admin/messages`: admin sends text/media messages with section + target group
- `x-admin-token` header protects admin routes

## Environment
The backend reads env values from the project root `.env` file.

Required:
- `PORT`
- `BASE_URL`
- `ADMIN_TOKEN`

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
5. Deploy

After deployment, admin panel will be available at:
- `https://<your-vercel-domain>/admin`

## Important note for Vercel storage

The current message storage uses a local JSON file. On Vercel, file storage is ephemeral (not permanent across redeploys/instances).

For production persistence, move message storage to a managed database (e.g. MongoDB Atlas, Supabase, Firebase, or Vercel KV/Postgres).

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
- `targetGroup` (`all|bscs|bsit|mcs|mba|paid-project-team`)
- `senderName` (optional)
