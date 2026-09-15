// Live analytics events for the Tangoo Glossary.
//   POST /api/events  -> record one event {type:'search'|'view'|'login', q?, n?, acr?}
//                        (the signed-in user's email is attached from the session
//                        cookie when present; anonymous browsing is still counted)
//   GET  /api/events?days=90 -> admin-only; returns the recent events so the admin
//                        Analytics tab can compute live totals across ALL users.
//
// Persisted in Vercel KV (a Redis list) when KV is attached; otherwise falls back
// to an in-memory buffer that survives only within a warm serverless instance.
// Self-contained (no shared imports) so it deploys as a standalone function.
import crypto from "crypto";

const COOKIE = "tg_glossary_session";
const sessionSecret = () =>
  process.env.SESSION_SECRET || process.env.SCIM_TOKEN || "tangoo-glossary-dev-secret";

type Session = { name: string; email: string; role: "admin" | "viewer"; exp: number };
function readSession(req: any): Session | null {
  const cookie = String(req.headers.cookie || "")
    .split(/; */)
    .find((c) => c.startsWith(COOKIE + "="));
  if (!cookie) return null;
  const [payload, sig] = cookie.slice(COOKIE.length + 1).split(".");
  if (!payload || !sig) return null;
  const expect = crypto.createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  try {
    if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expect))) return null;
  } catch {
    return null;
  }
  try {
    const obj = JSON.parse(Buffer.from(payload, "base64url").toString()) as Session;
    if (obj.exp && Date.now() > obj.exp) return null;
    return obj;
  } catch {
    return null;
  }
}

const adminEmails = () =>
  (process.env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);

const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const useKv = !!(KV_URL && KV_TOKEN);
const KEY = "glossary:events";
const CAP = 10000;

// In-memory fallback (per warm instance) so the feature degrades gracefully if KV
// is not attached yet.
const MEM: any[] = ((globalThis as any).__glossaryEvents ||= []);

async function kvClient() {
  const { createClient } = await import("@vercel/kv");
  return createClient({ url: KV_URL as string, token: KV_TOKEN as string });
}
const parse = (r: any) => {
  if (r && typeof r === "object") return r;
  try {
    return JSON.parse(r);
  } catch {
    return null;
  }
};

async function pushEvent(ev: any) {
  if (useKv) {
    const kv = await kvClient();
    await kv.lpush(KEY, JSON.stringify(ev));
    await kv.ltrim(KEY, 0, CAP - 1);
  } else {
    MEM.unshift(ev);
    if (MEM.length > CAP) MEM.length = CAP;
  }
}
async function readEvents(): Promise<any[]> {
  if (useKv) {
    const kv = await kvClient();
    const raw = (await kv.lrange(KEY, 0, CAP - 1)) as any[];
    return (raw || []).map(parse).filter(Boolean);
  }
  return MEM.slice();
}

const str = (v: any, max: number) => (typeof v === "string" ? v.slice(0, max) : "");
const TYPES = new Set(["search", "view", "login"]);

export default async function handler(req: any, res: any) {
  try {
    const sess = readSession(req);

    if (req.method === "POST") {
      let body: any = req.body;
      if (typeof body === "string") {
        try {
          body = JSON.parse(body);
        } catch {
          body = {};
        }
      }
      body = body || {};
      const type = str(body.type, 12);
      if (!TYPES.has(type)) return res.status(400).json({ error: "bad type" });
      const ev: any = { ts: Date.now(), type };
      if (type === "search") {
        ev.q = str(body.q, 120).trim();
        ev.n = Number.isFinite(body.n) ? Math.max(0, Math.floor(body.n)) : 0;
        if (ev.q.length < 2) return res.status(204).end();
      } else if (type === "view") {
        ev.acr = str(body.acr, 60).trim();
        if (!ev.acr) return res.status(204).end();
      }
      if (sess?.email) ev.email = sess.email.toLowerCase();
      await pushEvent(ev);
      return res.status(202).json({ ok: true });
    }

    if (req.method === "DELETE") {
      const isAdmin =
        sess && (sess.role === "admin" || adminEmails().includes(String(sess.email).toLowerCase()));
      if (!isAdmin) return res.status(403).json({ error: "admin only" });
      if (useKv) {
        const kv = await kvClient();
        await kv.del(KEY);
      } else {
        MEM.length = 0;
      }
      return res.status(200).json({ ok: true, cleared: true });
    }

    if (req.method === "GET") {
      const isAdmin =
        sess && (sess.role === "admin" || adminEmails().includes(String(sess.email).toLowerCase()));
      if (!isAdmin) return res.status(403).json({ error: "admin only" });
      const days = Math.min(365, Math.max(1, parseInt(String(req.query?.days || "90"), 10) || 90));
      const cut = Date.now() - days * 86400000;
      const events = (await readEvents()).filter((e) => e && e.ts >= cut);
      res.setHeader("Cache-Control", "no-store");
      return res.status(200).json({ events, kv: useKv, days });
    }

    res.setHeader("Allow", "GET, POST, DELETE");
    return res.status(405).json({ error: "method not allowed" });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || "events error" });
  }
}
