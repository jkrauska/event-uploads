# event-uploads

A simple Cloudflare Worker app for collecting event photos and videos.

No names, domains, or event-specific details in the code — everything is configured via environment variables at deploy time. Fork it for weddings, reunions, memorials, parties, or anything else.

## Architecture

```
site/               Static frontend (served by the Worker)
  index.html          Upload form — mobile-friendly, zero dependencies
  admin.html          Admin dashboard — preview & download uploads

worker/             Cloudflare Worker (API + static assets)
  src/index.ts        Handles uploads to R2, metadata to KV
  wrangler.toml       Worker config, bindings, and static asset serving
```

Everything deploys as a **single Cloudflare Worker** — the Worker handles `/api/*` routes and serves the static HTML files for everything else. No separate Pages project needed.

**Upload flow:**
1. User fills in name, optional message, selects files
2. Frontend calls `POST /api/create-upload` to get upload keys
3. Each file is `PUT` directly to the Worker, which stores it in R2
4. Frontend calls `POST /api/complete` to finalize metadata in KV

**Storage:**
- **R2** — file blobs at `uploads/YYYY-MM-DD/<name-slug>/<uploadId>/<rand>-filename.ext`
- **KV** — upload metadata keyed by `upload:<id>` with date-based indexes

## Deployment

### Prerequisites

- [Node.js](https://nodejs.org/) 18+
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) (`npm i -g wrangler`)
- A Cloudflare account with R2 enabled
- Log in to Wrangler: `wrangler login`

### Step 1: Create Cloudflare resources

```bash
# Create the R2 bucket for file storage
wrangler r2 bucket create event-uploads-media

# Create the KV namespace for upload metadata
wrangler kv namespace create EVENT_META
```

The KV command will output a namespace ID. Copy it into `worker/wrangler.toml`:

```toml
[[kv_namespaces]]
binding = "META"
id = "paste-your-namespace-id-here"
```

### Step 2: Install dependencies

```bash
cd worker
npm install
```

### Step 3: Deploy

```bash
cd worker
npm run deploy
```

Wrangler deploys the Worker code **and** the static site files from `site/` in a single operation. This also creates the Worker on Cloudflare if it doesn't exist yet. Your app will be live at:

```
https://event-uploads.<your-subdomain>.workers.dev
```

### Step 4: Set environment variables

Now that the Worker exists, set secrets via the Cloudflare dashboard (**Workers & Pages > your worker > Settings > Variables**) or via Wrangler:

```bash
# Required — admin API access token
wrangler secret put ADMIN_TOKEN

# Required — event display name (shown as page heading)
wrangler secret put EVENT_NAME

# Optional — subtitle text below the heading
wrangler secret put INTRO_TEXT

# Optional — passcode users must enter to upload
wrangler secret put EVENT_CODE
```

### Step 5: Custom domain (optional)

To use your own domain:

1. Go to **Workers & Pages > your worker > Settings > Domains & Routes**
2. Click **Add** > **Custom domain**
3. Enter your domain (e.g. `photos.example.com`)
4. Cloudflare handles DNS and SSL automatically

## Local development

Just one terminal — `wrangler dev` serves both the API and static files:

```bash
cd worker

# Create local secrets file (gitignored)
cat > .dev.vars << 'EOF'
ADMIN_TOKEN=test123
EVENT_NAME=My Test Event
INTRO_TEXT=Upload your photos and videos!
EOF

npm run dev
```

Then open http://localhost:8787 for the upload page and http://localhost:8787/admin.html for the admin dashboard.

## Security

- **IP rate limiting**: Each IP can complete up to 10 upload sessions per day (configurable via `UPLOADS_PER_IP_PER_DAY`). Prevents abuse as a file dropbox.
- **Per-session file cap**: Max 20 files per upload batch.
- **File size cap**: Max 100MB per file.
- **Client IP logging**: Stored in upload metadata and visible in the admin dashboard for audit.
- **Path validation**: Rejects upload keys with path traversal (`..`).

## Environment variables

| Variable | Required | Description |
|---|---|---|
| `ADMIN_TOKEN` | Yes | Bearer token for admin API access |
| `EVENT_NAME` | Yes | Display name shown as page heading |
| `INTRO_TEXT` | No | Subtitle text below the heading |
| `EVENT_CODE` | No | Passcode users must enter to upload |
| `UPLOADS_PER_IP_PER_DAY` | No | Max upload sessions per IP per day (default: 10) |

## API Routes

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/api/config` | — | Public event config (name, intro, code required?) |
| `POST` | `/api/create-upload` | Event code (if set) | Reserve upload, get keys |
| `PUT` | `/api/upload/:key` | — | Upload a single file to R2 |
| `POST` | `/api/complete` | — | Finalize upload, write KV metadata |
| `GET` | `/api/admin/list` | `Bearer ADMIN_TOKEN` | List all uploads |
| `GET` | `/api/admin/file/:key` | `Bearer ADMIN_TOKEN` | Stream a file from R2 |

## Customizing for your event

All event-specific text comes from environment variables — no code changes needed:

- **`EVENT_NAME`** — page heading (e.g. "Sarah's Wedding")
- **`INTRO_TEXT`** — subtitle (e.g. "Share your photos from the reception!")
- **`EVENT_CODE`** — if set, the upload form shows a passcode field

## License

MIT
