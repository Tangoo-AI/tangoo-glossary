// ---------------------------------------------------------------------------
// SCIM 2.0 endpoint for Rippling provisioning (Tangoo Glossary).
//   Base URL (Rippling form): https://glossary.tangoo.ai/api/scim/v2
//   Auth: Bearer <SCIM_TOKEN>  (set SCIM_TOKEN in Vercel env; paste same token in Rippling)
//
// Implements: /ServiceProviderConfig, /ResourceTypes, /Schemas, and full CRUD +
// filter + pagination for /Users and /Groups. A Rippling group named
// "Glossary Admins" (or "admin") maps a user to the admin role (see roleFor()).
//
// STORAGE: uses Vercel KV (Upstash Redis) when configured, so provisioned users
// and groups persist across serverless invocations. Falls back to an in-memory
// store (per-lambda, NOT durable) when KV env vars are absent — enough to pass
// Rippling's connection test before a KV store is attached. See SETUP-RIPPLING.md.
// ---------------------------------------------------------------------------

import { createClient } from "@vercel/kv";

type User = {
  id: string;
  externalId?: string;
  userName: string;
  name?: { givenName?: string; familyName?: string; formatted?: string };
  displayName?: string;
  emails?: { value: string; primary?: boolean }[];
  active: boolean;
  groups?: { value: string; display?: string }[];
  meta: { resourceType: string; created: string; lastModified: string; location: string };
  // Rippling can send title, userType, department, manager, photos, the
  // enterprise extension, etc. — we keep and echo them all.
  [key: string]: any;
};
type Group = {
  id: string;
  displayName: string;
  members: { value: string; display?: string }[];
  meta: { resourceType: string; created: string; lastModified: string; location: string };
};

// ---- storage layer -------------------------------------------------------
// Vercel KV / Upstash Redis when its env vars are present (set automatically
// when you attach a KV store in the Vercel dashboard — accepts either the
// KV_REST_API_* or UPSTASH_REDIS_REST_* naming); otherwise a per-lambda
// in-memory fallback so the endpoint still works before a store is attached.
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const useKv = !!(KV_URL && KV_TOKEN);
let _kv: ReturnType<typeof createClient> | null = null;
const kv = () => (_kv ??= createClient({ url: KV_URL as string, token: KV_TOKEN as string }));

const mem = { users: new Map<string, User>(), groups: new Map<string, Group>() };
type Kind = "users" | "groups";
const hashKey = (k: Kind) => `scim:${k}`;

const store = {
  async all<T = any>(kind: Kind): Promise<T[]> {
    if (useKv) {
      const obj = (await kv().hgetall(hashKey(kind))) as Record<string, T> | null;
      return obj ? Object.values(obj) : [];
    }
    return [...mem[kind].values()] as unknown as T[];
  },
  async get<T = any>(kind: Kind, id: string): Promise<T | null> {
    if (useKv) return ((await kv().hget(hashKey(kind), id)) as T) ?? null;
    return (mem[kind].get(id) as unknown as T) ?? null;
  },
  async set(kind: Kind, id: string, val: any): Promise<void> {
    if (useKv) await kv().hset(hashKey(kind), { [id]: val });
    else (mem[kind] as Map<string, any>).set(id, val);
  },
  async del(kind: Kind, id: string): Promise<void> {
    if (useKv) await kv().hdel(hashKey(kind), id);
    else mem[kind].delete(id);
  },
};

const USER_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:User";
const GROUP_SCHEMA = "urn:ietf:params:scim:schemas:core:2.0:Group";
const LIST_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
const ERR_SCHEMA = "urn:ietf:params:scim:api:messages:2.0:Error";

const uid = () => "tg-" + Math.random().toString(36).slice(2) + Date.now().toString(36);
const now = () => new Date().toISOString();
const baseUrl = (req: any) => `https://${req.headers.host}/api/scim/v2`;

function err(res: any, status: number, detail: string) {
  res.status(status).json({ schemas: [ERR_SCHEMA], detail, status: String(status) });
}

// "userName eq "x"" -> { attr:"userName", value:"x" }
function parseFilter(filter?: string) {
  if (!filter) return null;
  const m = filter.match(/(\w+)\s+eq\s+"([^"]*)"/i);
  return m ? { attr: m[1], value: m[2] } : null;
}

// Read the JSON body. Vercel only auto-parses application/json, but Rippling
// sends application/scim+json — so handle string/Buffer/unparsed-stream too,
// otherwise POST/PUT/PATCH bodies arrive empty and attributes are lost.
async function readBody(req: any): Promise<any> {
  const b = req.body;
  if (b && typeof b === "object" && !Buffer.isBuffer(b)) return b;
  if (typeof b === "string" && b) {
    try {
      return JSON.parse(b);
    } catch {
      return {};
    }
  }
  if (Buffer.isBuffer(b) && b.length) {
    try {
      return JSON.parse(b.toString("utf8"));
    } catch {
      return {};
    }
  }
  try {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

// Resolve the SCIM path segments after .../scim/v2/.
// We can't rely on Vercel populating req.query.path for the [...path] catch-all
// (it arrives empty in this deployment), so parse req.url as the source of truth
// and fall back to the query param if present. e.g. /api/scim/v2/Users/tg-1 -> ["Users","tg-1"]
function scimSegments(req: any): string[] {
  const dec = (s: string) => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  // Vercel populates req.query.path from the rewrite (array, or slash-joined string).
  const q = req.query?.path;
  if (Array.isArray(q)) {
    const a = q.filter(Boolean);
    if (a.length) return a.map(dec);
  } else if (typeof q === "string" && q) {
    return q.split("/").filter(Boolean).map(dec);
  }
  // Fall back to the raw URL (ignore the literal "[...path]" placeholder).
  return String(req.url || "")
    .split("?")[0]
    .replace(/^.*\/scim\/v2\/?/, "")
    .split("/")
    .filter((s) => s && !s.includes("["))
    .map(dec);
}

export default async function handler(req: any, res: any) {
  // ---- auth ----
  const token = process.env.SCIM_TOKEN;
  if (!token) return err(res, 500, "SCIM_TOKEN is not configured on the server.");
  const auth = req.headers.authorization || "";
  if (auth !== `Bearer ${token}`) return err(res, 401, "Unauthorized.");

  res.setHeader("Content-Type", "application/scim+json");
  const seg: string[] = scimSegments(req);
  const [resource, id] = seg;
  const method = req.method;
  const body = method === "GET" || method === "DELETE" ? {} : await readBody(req);

  try {
    // ---- discovery ----
    if (resource === "ServiceProviderConfig") {
      return res.status(200).json({
        schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
        patch: { supported: true },
        bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
        filter: { supported: true, maxResults: 200 },
        changePassword: { supported: false },
        sort: { supported: false },
        etag: { supported: false },
        authenticationSchemes: [{ type: "oauthbearertoken", name: "OAuth Bearer Token", description: "Bearer token" }],
      });
    }
    if (resource === "ResourceTypes") {
      return res.status(200).json([
        { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "User", name: "User", endpoint: "/Users", schema: USER_SCHEMA },
        { schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"], id: "Group", name: "Group", endpoint: "/Groups", schema: GROUP_SCHEMA },
      ]);
    }
    if (resource === "Schemas") {
      return res.status(200).json([{ id: USER_SCHEMA }, { id: GROUP_SCHEMA }]);
    }

    // ---- Users ----
    if (resource === "Users") {
      if (method === "GET" && !id) {
        const all = await store.all<User>("users");
        const f = parseFilter(req.query.filter);
        const filtered = f
          ? all.filter((u) => String((u as any)[f.attr] ?? (f.attr === "userName" ? u.userName : "")).toLowerCase() === f.value.toLowerCase())
          : all;
        const start = parseInt(req.query.startIndex ?? "1", 10);
        const count = parseInt(req.query.count ?? "100", 10);
        const page = filtered.slice(start - 1, start - 1 + count);
        return res.status(200).json({ schemas: [LIST_SCHEMA], totalResults: filtered.length, startIndex: start, itemsPerPage: page.length, Resources: page });
      }
      if (method === "GET" && id) {
        const u = await store.get<User>("users", id);
        return u ? res.status(200).json(u) : err(res, 404, "User not found.");
      }
      if (method === "POST") {
        const newId = uid();
        const u: User = {
          ...body, // keep every attribute Rippling sent (externalId, title, department, manager, …)
          id: newId,
          schemas: body.schemas || [USER_SCHEMA],
          active: body.active ?? true,
          groups: [],
          meta: { resourceType: "User", created: now(), lastModified: now(), location: `${baseUrl(req)}/Users/${newId}` },
        };
        await store.set("users", newId, u);
        return res.status(201).json(u);
      }
      if ((method === "PUT" || method === "PATCH") && id) {
        const u = await store.get<User>("users", id);
        if (!u) return err(res, 404, "User not found.");
        if (method === "PUT") {
          Object.assign(u, body, { id: u.id, meta: u.meta }); // full replace, preserve id/meta
        } else {
          for (const op of body.Operations || []) {
            const val = op.value;
            if (op.path === "active" || (val && "active" in val)) u.active = op.path === "active" ? val : val.active;
            else if (op.path && val !== undefined) (u as any)[op.path] = val;
            else if (val && typeof val === "object") Object.assign(u, val);
          }
        }
        u.meta.lastModified = now();
        await store.set("users", id, u);
        return res.status(200).json(u);
      }
      if (method === "DELETE" && id) {
        await store.del("users", id);
        return res.status(204).end();
      }
    }

    // ---- Groups ----
    if (resource === "Groups") {
      if (method === "GET" && !id) {
        const all = await store.all<Group>("groups");
        const f = parseFilter(req.query.filter);
        const filtered = f ? all.filter((g) => g.displayName.toLowerCase() === f.value.toLowerCase()) : all;
        return res.status(200).json({ schemas: [LIST_SCHEMA], totalResults: filtered.length, startIndex: 1, itemsPerPage: filtered.length, Resources: filtered });
      }
      if (method === "GET" && id) {
        const g = await store.get<Group>("groups", id);
        return g ? res.status(200).json(g) : err(res, 404, "Group not found.");
      }
      if (method === "POST") {
        const newId = uid();
        const g: Group = { id: newId, displayName: body.displayName, members: body.members || [], meta: { resourceType: "Group", created: now(), lastModified: now(), location: `${baseUrl(req)}/Groups/${newId}` } };
        await store.set("groups", newId, g);
        return res.status(201).json(g);
      }
      if ((method === "PUT" || method === "PATCH") && id) {
        const g = await store.get<Group>("groups", id);
        if (!g) return err(res, 404, "Group not found.");
        if (method === "PUT") {
          g.displayName = body.displayName ?? g.displayName;
          g.members = body.members ?? g.members;
        } else {
          for (const op of body.Operations || []) {
            if (op.op?.toLowerCase() === "add" && op.path === "members") g.members.push(...(op.value || []));
            else if (op.op?.toLowerCase() === "remove" && op.path?.startsWith("members")) {
              const m = op.path.match(/value eq "([^"]+)"/);
              if (m) g.members = g.members.filter((x) => x.value !== m[1]);
            } else if (op.value?.displayName) g.displayName = op.value.displayName;
          }
        }
        g.meta.lastModified = now();
        await store.set("groups", id, g);
        return res.status(200).json(g);
      }
      if (method === "DELETE" && id) {
        await store.del("groups", id);
        return res.status(204).end();
      }
    }

    return err(res, 404, "Resource not found.");
  } catch (e: any) {
    return err(res, 500, `Server error: ${e?.message || "unknown"}`);
  }
}

// Role mapping: members of an admin group are admins. The group name is
// configurable via ADMIN_GROUP_NAMES (comma-separated); default covers
// "admin" / "Store Admins". Everyone else is a viewer.
const ADMIN_GROUP_NAMES = (process.env.ADMIN_GROUP_NAMES || "admin,admins,glossary admin,glossary admins")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const isAdminGroup = (name: any) => ADMIN_GROUP_NAMES.includes(String(name || "").trim().toLowerCase());

export async function roleFor(user: User): Promise<"admin" | "viewer"> {
  const groups = await store.all<Group>("groups");
  const isAdmin = groups.some((g) => isAdminGroup(g.displayName) && g.members.some((m) => m.value === user.id));
  return isAdmin ? "admin" : "viewer";
}
