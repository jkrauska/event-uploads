/**
 * event-uploads Worker
 *
 * Handles file uploads to R2 with metadata in KV.
 * No event-specific names in code — everything comes from env vars.
 *
 * Routes:
 *   POST /api/create-upload   — reserve an upload (returns presigned-style keys)
 *   PUT  /api/upload/:key+     — upload a single file to R2
 *   POST /api/complete         — finalize upload, write metadata to KV
 *   GET  /api/config            — public event config (name, whether code is required)
 *   GET  /api/admin/list       — list all uploads (requires ADMIN_TOKEN)
 *   GET  /api/admin/file/:key+ — download a file from R2 (requires ADMIN_TOKEN)
 *   DELETE /api/admin/file/:key+ — delete a file from R2 and KV (requires ADMIN_TOKEN)
 */

export interface Env {
  MEDIA: R2Bucket;
  META: KVNamespace;
  EVENT_NAME?: string;
  INTRO_TEXT?: string;
  FOOTER_TEXT?: string;
  EVENT_CODE?: string;
  ADMIN_TOKEN?: string;
  /** Max upload sessions per visitor per day (default 10) */
  UPLOADS_PER_VISITOR_PER_DAY?: string;
}

interface FileInfo {
  filename: string;
  type: string;
  size: number;
}

interface CreateUploadRequest {
  name: string;
  message?: string;
  code?: string;
  files: FileInfo[];
}

interface CompleteRequest {
  uploadId: string;
  name: string;
  message?: string;
  code?: string;
  uploads: {
    key: string;
    filename: string;
    type: string;
    size: number;
  }[];
}

interface UploadMeta {
  uploadId: string;
  name: string;
  message?: string;
  files: {
    key: string;
    filename: string;
    type: string;
    size: number;
  }[];
  timestamp: string;
  clientIP?: string; // For audit; only stored if available
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function err(message: string, status = 400): Response {
  return json({ error: message }, status);
}

function cors(response: Response, origin: string): Response {
  const headers = new Headers(response.headers);
  headers.set("access-control-allow-origin", origin);
  headers.set("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
  headers.set("access-control-allow-headers", "content-type, authorization");
  headers.set("access-control-max-age", "86400");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

function generateId(): string {
  const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
  let id = "";
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  for (const b of bytes) {
    id += chars[b % chars.length];
  }
  return id;
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

function getClientIP(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

// Rate limit defaults; overridable via env
const DEFAULT_UPLOADS_PER_VISITOR_PER_DAY = 10;
const MAX_FILES_PER_SESSION = 20;
const MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024; // 100MB per file
const VISITOR_COOKIE_NAME = "eu_vid";

function getUploadsPerVisitorLimit(env: Env): number {
  const v = env.UPLOADS_PER_VISITOR_PER_DAY;
  if (!v) return DEFAULT_UPLOADS_PER_VISITOR_PER_DAY;
  const n = parseInt(v, 10);
  return isNaN(n) || n < 1 ? DEFAULT_UPLOADS_PER_VISITOR_PER_DAY : n;
}

function getVisitorId(request: Request): string | null {
  const cookie = request.headers.get("cookie") || "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${VISITOR_COOKIE_NAME}=([^;]+)`));
  return match ? match[1] : null;
}

function makeVisitorCookie(visitorId: string): string {
  // Cookie lasts 30 days; SameSite=Lax so it's sent on normal navigation
  return `${VISITOR_COOKIE_NAME}=${visitorId}; Path=/; Max-Age=${60 * 60 * 24 * 30}; SameSite=Lax; Secure; HttpOnly`;
}

// Note: KV has no atomic increment; concurrent complete requests could race.
// Acceptable for event photo sharing; use D1/Durable Objects for strict limits.
async function checkAndIncrementRateLimit(
  visitorId: string,
  env: Env
): Promise<{ allowed: boolean; count: number; limit: number }> {
  const limit = getUploadsPerVisitorLimit(env);
  const date = today();
  const key = `ratelimit:${date}:${visitorId}`;
  const raw = await env.META.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= limit) {
    return { allowed: false, count, limit };
  }
  await env.META.put(key, String(count + 1), {
    expirationTtl: 86400 * 2, // 2 days — KV will auto-expire stale keys
  });
  return { allowed: true, count: count + 1, limit };
}

function isValidUploadKey(key: string): boolean {
  if (!key.startsWith("uploads/")) return false;
  if (key.includes("..")) return false;
  // Must match: uploads/YYYY-MM-DD/slug/id/rand-filename
  const parts = key.split("/");
  if (parts.length < 5) return false;
  const datePart = parts[1];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datePart)) return false;
  return true;
}

/** Extract uploadId from R2 key: uploads/date/slug/uploadId/rand-filename */
function parseUploadIdFromKey(key: string): string | null {
  const parts = key.split("/");
  if (parts.length < 5) return null;
  return parts[3] || null;
}

const PENDING_TTL = 3600; // 1 hour

// ---------------------------------------------------------------------------
// Route handlers
// ---------------------------------------------------------------------------

async function handleCreateUpload(
  request: Request,
  env: Env
): Promise<Response> {
  const clientIP = getClientIP(request);

  let body: CreateUploadRequest;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON");
  }

  const { name, code, files } = body;

  if (!name || typeof name !== "string") {
    return err("name is required");
  }
  if (!files || !Array.isArray(files) || files.length === 0) {
    return err("files array is required");
  }
  if (files.length > MAX_FILES_PER_SESSION) {
    return err(
      `Maximum ${MAX_FILES_PER_SESSION} files per upload. You selected ${files.length}.`,
      400
    );
  }

  // Check event code first (don't burn rate limit on wrong code)
  if (env.EVENT_CODE && code !== env.EVENT_CODE) {
    return err("Invalid event code", 403);
  }

  // Get or create visitor ID for rate limiting (cookie-based, not IP)
  let visitorId = getVisitorId(request);
  let isNewVisitor = false;
  if (!visitorId) {
    visitorId = generateId();
    isNewVisitor = true;
  }

  const uploadId = generateId();
  const slug = slugify(name);
  const date = today();

  const uploads = files.map((f) => {
    const rand = generateId().slice(0, 8);
    const safeName = f.filename.replace(/[^a-zA-Z0-9._-]/g, "_");
    const key = `uploads/${date}/${slug}/${uploadId}/${rand}-${safeName}`;
    return {
      key,
      url: `/api/upload/${key}`,
      filename: f.filename,
      type: f.type,
      size: f.size,
    };
  });

  // Store pending session (1hr TTL); rate limit happens at complete
  const pendingKeys = uploads.map((u) => u.key);
  await env.META.put(
    `pending:${uploadId}`,
    JSON.stringify({ keys: pendingKeys, date, visitorId }),
    { expirationTtl: PENDING_TTL }
  );

  console.info(`Upload created: uploadId=${uploadId} visitor=${visitorId} ip=${clientIP} files=${files.length}`);

  // Build response with visitor cookie
  const response = json({ uploadId, uploads });
  if (isNewVisitor) {
    const headers = new Headers(response.headers);
    headers.set("set-cookie", makeVisitorCookie(visitorId));
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  }
  return response;
}

async function handleUpload(
  request: Request,
  env: Env,
  key: string
): Promise<Response> {
  const clientIP = getClientIP(request);

  if (!isValidUploadKey(key)) {
    console.warn(`Invalid upload key rejected from IP ${clientIP}: ${key}`);
    return err("Invalid key", 400);
  }

  // Reject empty body
  const contentLength = request.headers.get("content-length");
  if (contentLength !== null) {
    const size = parseInt(contentLength, 10);
    if (isNaN(size) || size < 1) {
      return err("Empty or invalid content-length", 400);
    }
    if (size > MAX_FILE_SIZE_BYTES) {
      return err(
        `File too large. Maximum size is ${MAX_FILE_SIZE_BYTES / 1024 / 1024}MB.`,
        413
      );
    }
  } else if (!request.body) {
    return err("Missing request body", 400);
  }

  // Verify key belongs to a valid pending session
  const uploadId = parseUploadIdFromKey(key);
  if (!uploadId) return err("Invalid key format", 400);
  const pendingRaw = await env.META.get(`pending:${uploadId}`);
  if (!pendingRaw) {
    return err("Upload session expired or invalid. Please start a new upload.", 410);
  }
  const pending = JSON.parse(pendingRaw) as { keys: string[] };
  if (!pending.keys?.includes(key)) {
    return err("Invalid key for this upload session", 400);
  }

  const contentType =
    request.headers.get("content-type") || "application/octet-stream";

  await env.MEDIA.put(key, request.body, {
    httpMetadata: { contentType },
  });

  return json({ ok: true, key });
}

async function handleComplete(
  request: Request,
  env: Env
): Promise<Response> {
  const clientIP = getClientIP(request);

  let body: CompleteRequest;
  try {
    body = await request.json();
  } catch {
    return err("Invalid JSON");
  }

  const { uploadId, name, message, uploads } = body;

  if (!uploadId || !name || !uploads?.length) {
    return err("Missing required fields");
  }

  // Idempotent: if already completed, return success without re-adding to index
  const existingMeta = await env.META.get(`upload:${uploadId}`);
  if (existingMeta) {
    return json({ ok: true, uploadId });
  }

  // Verify pending session exists and uploads match
  const pendingRaw = await env.META.get(`pending:${uploadId}`);
  if (!pendingRaw) {
    return err("Upload session expired or invalid. Please start a new upload.", 410);
  }
  const pending = JSON.parse(pendingRaw) as { keys: string[]; date: string; visitorId: string };
  const pendingKeySet = new Set(pending.keys || []);
  const bodyKeys = uploads.map((u) => u.key);
  if (bodyKeys.length !== pendingKeySet.size || bodyKeys.some((k) => !pendingKeySet.has(k))) {
    return err("Uploads do not match the reserved session", 400);
  }

  // Rate limit at complete (not create) — only count successful uploads
  const visitorId = pending.visitorId || getVisitorId(request);
  if (visitorId) {
    const { allowed, limit } = await checkAndIncrementRateLimit(visitorId, env);
    if (!allowed) {
      return err(
        `Upload limit reached. You can upload up to ${limit} times per day. Try again tomorrow.`,
        429
      );
    }
  }

  // Delete pending; upload is finalized
  await env.META.delete(`pending:${uploadId}`);

  const meta: UploadMeta = {
    uploadId,
    name,
    message: message || undefined,
    files: uploads.map((u) => ({
      key: u.key,
      filename: u.filename,
      type: u.type,
      size: u.size,
    })),
    timestamp: new Date().toISOString(),
    ...(clientIP !== "unknown" && { clientIP }),
  };

  await env.META.put(`upload:${uploadId}`, JSON.stringify(meta));

  // Use date from pending (matches R2 path) to handle midnight edge case
  const indexKey = `index:${pending.date}`;
  const existingRaw = await env.META.get(indexKey);
  const existing: string[] = existingRaw ? JSON.parse(existingRaw) : [];
  existing.push(uploadId);
  await env.META.put(indexKey, JSON.stringify(existing));

  return json({ ok: true, uploadId });
}

async function handleAdminList(
  request: Request,
  env: Env
): Promise<Response> {
  if (!checkAdmin(request, env)) {
    return err("Unauthorized", 401);
  }

  // List all index keys to gather upload IDs
  const allIds: string[] = [];
  let cursor: string | undefined;

  do {
    const list = await env.META.list({
      prefix: "index:",
      cursor,
    });
    for (const key of list.keys) {
      const raw = await env.META.get(key.name);
      if (raw) {
        const ids: string[] = JSON.parse(raw);
        allIds.push(...ids);
      }
    }
    cursor = list.list_complete ? undefined : list.cursor;
  } while (cursor);

  // Fetch all upload metadata
  const uploads: UploadMeta[] = [];
  for (const id of allIds) {
    const raw = await env.META.get(`upload:${id}`);
    if (raw) {
      uploads.push(JSON.parse(raw));
    }
  }

  // Sort newest first
  uploads.sort(
    (a, b) =>
      new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
  );

  return json({ uploads, count: uploads.length });
}

async function handleAdminFile(
  request: Request,
  env: Env,
  key: string
): Promise<Response> {
  if (!checkAdmin(request, env)) {
    return err("Unauthorized", 401);
  }

  const object = await env.MEDIA.get(key);
  if (!object) {
    return err("Not found", 404);
  }

  const headers = new Headers();
  headers.set(
    "content-type",
    object.httpMetadata?.contentType || "application/octet-stream"
  );
  headers.set("content-length", String(object.size));

  return new Response(object.body, { headers });
}

async function handleAdminDelete(
  request: Request,
  env: Env,
  key: string
): Promise<Response> {
  if (!checkAdmin(request, env)) {
    return err("Unauthorized", 401);
  }

  if (!isValidUploadKey(key)) {
    return err("Invalid key", 400);
  }

  const uploadId = parseUploadIdFromKey(key);
  if (!uploadId) return err("Invalid key format", 400);

  const metaRaw = await env.META.get(`upload:${uploadId}`);
  if (!metaRaw) {
    await env.MEDIA.delete(key); // Orphaned file; still delete from R2
    return json({ ok: true, deleted: key });
  }

  const meta = JSON.parse(metaRaw) as UploadMeta;
  const fileIndex = meta.files.findIndex((f) => f.key === key);
  if (fileIndex === -1) {
    await env.MEDIA.delete(key); // File not in metadata; delete from R2
    return json({ ok: true, deleted: key });
  }

  await env.MEDIA.delete(key);

  meta.files.splice(fileIndex, 1);

  if (meta.files.length === 0) {
    await env.META.delete(`upload:${uploadId}`);
    const dateFromKey = key.split("/")[1];
    const indexKey = `index:${dateFromKey}`;
    const indexRaw = await env.META.get(indexKey);
    if (indexRaw) {
      const ids: string[] = JSON.parse(indexRaw);
      const idx = ids.indexOf(uploadId);
      if (idx !== -1) {
        ids.splice(idx, 1);
        if (ids.length > 0) {
          await env.META.put(indexKey, JSON.stringify(ids));
        } else {
          await env.META.delete(indexKey);
        }
      }
    }
  } else {
    await env.META.put(`upload:${uploadId}`, JSON.stringify(meta));
  }

  return json({ ok: true, deleted: key });
}

/** Strip accidental shell escapes like \! that can appear when setting secrets */
function unescapeConfig(s: string | undefined): string {
  if (!s) return "";
  return s.replace(/\\!/g, "!");
}

function handleConfig(env: Env): Response {
  return json({
    eventName: unescapeConfig(env.EVENT_NAME) || "Event",
    introText: unescapeConfig(env.INTRO_TEXT),
    footerText: unescapeConfig(env.FOOTER_TEXT) || "Made with \u2764\uFE0F by my favorite son-in-law, Joel.",
    requireCode: !!env.EVENT_CODE,
  });
}

function checkAdmin(request: Request, env: Env): boolean {
  if (!env.ADMIN_TOKEN) return false;
  const auth = request.headers.get("authorization") || "";
  return auth === `Bearer ${env.ADMIN_TOKEN}`;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export default {
  async fetch(
    request: Request,
    env: Env,
    _ctx: ExecutionContext
  ): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method;
    const origin = request.headers.get("origin") || "*";

    // CORS preflight
    if (method === "OPTIONS") {
      return cors(new Response(null, { status: 204 }), origin);
    }

    let response: Response;

    try {
      if (method === "GET" && path === "/api/config") {
        response = handleConfig(env);
      } else if (method === "POST" && path === "/api/create-upload") {
        response = await handleCreateUpload(request, env);
      } else if (method === "PUT" && path.startsWith("/api/upload/")) {
        const key = path.slice("/api/upload/".length);
        response = await handleUpload(request, env, decodeURIComponent(key));
      } else if (method === "POST" && path === "/api/complete") {
        response = await handleComplete(request, env);
      } else if (method === "GET" && path === "/api/admin/list") {
        response = await handleAdminList(request, env);
      } else if (method === "GET" && path.startsWith("/api/admin/file/")) {
        const key = path.slice("/api/admin/file/".length);
        response = await handleAdminFile(
          request,
          env,
          decodeURIComponent(key)
        );
      } else if (method === "DELETE" && path.startsWith("/api/admin/file/")) {
        const key = path.slice("/api/admin/file/".length);
        response = await handleAdminDelete(
          request,
          env,
          decodeURIComponent(key)
        );
      } else {
        response = err("Not found", 404);
      }
    } catch (e) {
      console.error("Worker error:", e);
      response = err("Internal server error", 500);
    }

    return cors(response, origin);
  },
};
