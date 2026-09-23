import { verifyAccessJwt } from "./access";
import { renderPage } from "./page";

export interface Env {
  DB: D1Database;
  ACCESS_TEAM_DOMAIN?: string;
  ACCESS_AUD?: string;
}

interface Note {
  content: string;
  version: number;
  updated_at: number;
}

const MAX_NOTE_BYTES = 1_000_000; // D1 rows max out at 2 MB; leave headroom.
const MAX_KEY_LENGTH = 512;

let schemaReady: Promise<unknown> | null = null;
function ensureSchema(db: D1Database) {
  schemaReady ??= db
    .prepare(
      `CREATE TABLE IF NOT EXISTS notes (
        key        TEXT PRIMARY KEY,
        content    TEXT NOT NULL,
        version    INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
    )
    .run()
    .catch((err) => {
      schemaReady = null;
      throw err;
    });
  return schemaReady;
}

// "/Groceries/" and "/groceries" are the same note.
function noteKey(url: URL): string | null {
  let path: string;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return null;
  }
  const key = path.replace(/^\/+|\/+$/g, "").toLowerCase();
  return key.length > MAX_KEY_LENGTH ? null : key;
}

const baseHeaders = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
};

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...baseHeaders, "Content-Type": "application/json; charset=utf-8" },
  });
}

function text(body: string, status = 200) {
  return new Response(body, {
    status,
    headers: { ...baseHeaders, "Content-Type": "text/plain; charset=utf-8" },
  });
}

async function getNote(db: D1Database, key: string): Promise<Note | null> {
  return db.prepare("SELECT content, version, updated_at FROM notes WHERE key = ?1").bind(key).first<Note>();
}

async function saveNote(db: D1Database, key: string, request: Request): Promise<Response> {
  let body: { content?: unknown; baseVersion?: unknown; force?: unknown };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  if (typeof body.content !== "string") return json({ error: "content must be a string" }, 400);
  const content = body.content;
  if (new TextEncoder().encode(content).length > MAX_NOTE_BYTES) {
    return json({ error: "Note too large (1 MB max)" }, 413);
  }
  const force = body.force === true;
  const baseVersion = typeof body.baseVersion === "number" ? body.baseVersion : 0;
  const now = Date.now();

  if (content === "") {
    // Empty notes are removed so the table only holds notes with something in them.
    const res = await db
      .prepare("DELETE FROM notes WHERE key = ?1 AND (?2 OR version = ?3)")
      .bind(key, force ? 1 : 0, baseVersion)
      .run();
    if (res.meta.changes > 0) return json({ version: 0, updated_at: now });
    const current = await getNote(db, key);
    if (!current) return json({ version: 0, updated_at: now });
    return json({ conflict: true, ...current }, 409);
  }

  // Insert, or update only if nobody else saved since we loaded (optimistic locking).
  const row = await db
    .prepare(
      `INSERT INTO notes (key, content, version, updated_at) VALUES (?1, ?2, 1, ?3)
       ON CONFLICT(key) DO UPDATE SET
         content = excluded.content,
         version = notes.version + 1,
         updated_at = excluded.updated_at
       WHERE ?4 OR notes.version = ?5
       RETURNING version, updated_at`,
    )
    .bind(key, content, now, force ? 1 : 0, baseVersion)
    .first<{ version: number; updated_at: number }>();
  if (row) return json(row);

  const current = await getNote(db, key);
  return json({ conflict: true, ...current }, 409);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD) {
      const ok = await verifyAccessJwt(request, env.ACCESS_TEAM_DOMAIN, env.ACCESS_AUD);
      if (!ok) return text("Forbidden", 403);
    }

    const url = new URL(request.url);
    if (url.pathname === "/favicon.ico" || url.pathname === "/robots.txt") {
      return url.pathname === "/robots.txt" ? text("User-agent: *\nDisallow: /\n") : new Response(null, { status: 204 });
    }

    const key = noteKey(url);
    if (key === null) return text("Bad note name", 400);

    await ensureSchema(env.DB);

    switch (request.method) {
      case "GET":
      case "HEAD": {
        const note = await getNote(env.DB, key);
        if (url.searchParams.has("raw")) return text(note?.content ?? "");
        if (url.searchParams.has("json")) return json(note ?? { content: "", version: 0, updated_at: 0 });
        return new Response(renderPage(key, note), {
          headers: { ...baseHeaders, "Content-Type": "text/html; charset=utf-8" },
        });
      }
      case "PUT":
      case "POST":
        return saveNote(env.DB, key, request);
      default:
        return text("Method not allowed", 405);
    }
  },
} satisfies ExportedHandler<Env>;
