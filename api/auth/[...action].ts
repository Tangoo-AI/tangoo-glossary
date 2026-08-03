// ---------------------------------------------------------------------------
// SAML SSO (Service Provider) for the Tangoo Glossary, federated with Rippling.
// Ported from the Tangoo Store (store.tangoo.ai) — same flow, pointed at the
// glossary's own Rippling app.
//
// Routes (all under https://glossary.tangoo.ai/api/auth):
//   GET  /login     -> redirect the browser to Rippling (SP-initiated SSO)
//   POST /acs       -> Assertion Consumer Service: Rippling posts the signed
//                      SAML assertion here; we validate it, resolve the role,
//                      set a signed session cookie, and redirect into the app.
//   GET  /metadata  -> SP metadata XML (hand this URL to Rippling, Step 2)
//   GET  /me        -> current session as JSON (the app calls this on load)
//   GET  /logout    -> clear the session cookie
//
// IdP values (entity id, SSO url, cert) for the glossary's Rippling app are read
// from env vars — set them in Vercel after you create the Rippling SAML app.
// Admin role: any SAML group/role claim matching ADMIN_GROUP_NAMES, or an email
// in ADMIN_EMAILS. Optional SCIM enrichment kicks in only if Vercel KV is set.
// ---------------------------------------------------------------------------

import { SAML } from "@node-saml/node-saml";
import crypto from "crypto";

// ---- Rippling IdP (set these in Vercel from the glossary's Rippling app) ----
const IDP_ENTITY_ID = (process.env.SAML_IDP_ENTITY_ID || "").trim();
const IDP_SSO_URL = (process.env.SAML_IDP_SSO_URL || "").trim();
const IDP_CERT = (process.env.SAML_IDP_CERT || "").replace(/\\n/g, "\n").trim();

// ---- Service Provider (this app) ----------------------------------------
const SP_ORIGIN = (process.env.SP_ORIGIN || "https://glossary.tangoo.ai").replace(/\/$/, "");
const SP_ENTITY_ID = `${SP_ORIGIN}/api/auth/metadata`; // also the metadata URL
const ACS_URL = `${SP_ORIGIN}/api/auth/acs`;

const COOKIE = "tg_glossary_session";
const MAX_AGE = 60 * 60 * 12; // 12h
const sessionSecret = () => process.env.SESSION_SECRET || process.env.SCIM_TOKEN || "tangoo-glossary-dev-secret";

function saml(): SAML {
  if (!IDP_ENTITY_ID || !IDP_SSO_URL || !IDP_CERT) {
    throw new Error(
      "Rippling not configured. Set SAML_IDP_ENTITY_ID, SAML_IDP_SSO_URL and SAML_IDP_CERT in Vercel (from the glossary's Rippling SAML app)."
    );
  }
  return new SAML({
    issuer: SP_ENTITY_ID,
    callbackUrl: ACS_URL,
    entryPoint: IDP_SSO_URL,
    idpCert: IDP_CERT,
    idpIssuer: IDP_ENTITY_ID,
    audience: SP_ENTITY_ID,
    wantAssertionsSigned: true,
    wantAuthnResponseSigned: false,
    identifierFormat: null,
    validateInResponseTo: "never" as any,
    disableRequestedAuthnContext: true,
    acceptedClockSkewMs: 60_000,
    generateUniqueId: () => "tg" + crypto.randomBytes(10).toString("hex"),
  } as any);
}

type Session = { name: string; email: string; role: "admin" | "viewer"; photo?: string; title?: string; department?: string; exp: number };

function signSession(s: Omit<Session, "exp">): string {
  const payload = Buffer.from(JSON.stringify({ ...s, exp: Date.now() + MAX_AGE * 1000 })).toString("base64url");
  const sig = crypto.createHmac("sha256", sessionSecret()).update(payload).digest("base64url");
  return `${payload}.${sig}`;
}
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
const setCookie = (res: any, value: string, maxAge: number) =>
  res.setHeader("Set-Cookie", `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`);

// ---- role lookup ---------------------------------------------------------
const ADMIN_GROUP_NAMES = (process.env.ADMIN_GROUP_NAMES || "admin,admins,glossary admin,glossary admins")
  .split(",")
  .map((s) => s.trim().toLowerCase())
  .filter(Boolean);
const isAdminGroup = (name: any) => ADMIN_GROUP_NAMES.includes(String(name || "").trim().toLowerCase());

// Optional SCIM enrichment (name/photo/title/department + admin group) — only if
// Vercel KV is attached. Without KV this is skipped and role comes from the SAML
// claim / ADMIN_EMAILS.
const KV_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const useKv = !!(KV_URL && KV_TOKEN);
type ScimInfo = { inAdmin: boolean; displayName?: string; photo?: string; title?: string; department?: string };
async function lookupScim(email: string): Promise<ScimInfo> {
  if (!useKv) return { inAdmin: false };
  try {
    const { createClient } = await import("@vercel/kv");
    const kv = createClient({ url: KV_URL as string, token: KV_TOKEN as string });
    const [users, groups] = await Promise.all([
      kv.hgetall("scim:users") as Promise<Record<string, any> | null>,
      kv.hgetall("scim:groups") as Promise<Record<string, any> | null>,
    ]);
    const lc = email.toLowerCase();
    const user: any = Object.values(users || {}).find((u: any) =>
      [u.userName, u.emails?.[0]?.value].filter(Boolean).some((v: string) => v.toLowerCase() === lc)
    );
    if (!user) return { inAdmin: false };
    const inAdmin = Object.values(groups || {}).some(
      (g: any) => isAdminGroup(g.displayName) && g.members?.some((m: any) => m.value === user.id)
    );
    const displayName =
      user.displayName ||
      user.name?.formatted ||
      [user.name?.givenName, user.name?.familyName].filter(Boolean).join(" ").trim() ||
      undefined;
    const ent = user["urn:ietf:params:scim:schemas:extension:enterprise:2.0:User"];
    const department = typeof ent?.department === "string" ? ent.department : undefined;
    const photoRaw = user.photos?.[0]?.value || user.photos?.[0];
    const photo = typeof photoRaw === "string" && /^https?:\/\//.test(photoRaw) ? photoRaw : undefined;
    return { inAdmin, displayName, photo, title: typeof user.title === "string" ? user.title : undefined, department };
  } catch {
    return { inAdmin: false };
  }
}

function actionOf(req: any): string {
  const q = req.query?.action;
  if (Array.isArray(q) && q.length) return String(q[0]);
  if (typeof q === "string" && q) return q.split("/").filter(Boolean)[0] || "";
  const fromUrl = String(req.url || "")
    .split("?")[0]
    .replace(/^.*\/auth\/?/, "")
    .split("/")
    .filter((s) => s && !s.includes("["));
  return fromUrl[0] || "";
}
const safePath = (p: any) => (typeof p === "string" && p.startsWith("/") && !p.startsWith("//") ? p : "/");

export default async function handler(req: any, res: any) {
  const action = actionOf(req);
  try {
    if (action === "metadata") {
      const xml = saml().generateServiceProviderMetadata(null, null);
      res.setHeader("Content-Type", "application/xml");
      return res.status(200).send(xml);
    }

    if (action === "me") {
      const s = readSession(req);
      if (!s) return res.status(401).json({ error: "no session" });
      const fresh = await lookupScim(s.email);
      return res.status(200).json({
        name: fresh.displayName || s.name,
        email: s.email,
        role: fresh.inAdmin || s.role === "admin" ? "admin" : "viewer",
        photo: fresh.photo || s.photo,
        title: fresh.title || s.title,
        department: fresh.department || s.department,
      });
    }

    if (action === "logout") {
      setCookie(res, "", 0);
      return res.status(204).end();
    }

    if (action === "login") {
      const relay = safePath(req.query?.next);
      const url = await saml().getAuthorizeUrlAsync(relay, undefined, {} as any);
      res.statusCode = 302;
      res.setHeader("Location", url);
      return res.end();
    }

    if (action === "acs") {
      let body: any = req.body;
      if (typeof body === "string") body = Object.fromEntries(new URLSearchParams(body));
      else if (Buffer.isBuffer(body)) body = Object.fromEntries(new URLSearchParams(body.toString("utf8")));
      else if (!body || typeof body !== "object") {
        const chunks: Buffer[] = [];
        for await (const c of req) chunks.push(typeof c === "string" ? Buffer.from(c) : c);
        body = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString("utf8")));
      }
      if (!body.SAMLResponse) return res.status(400).send("Missing SAMLResponse.");

      const { profile } = await saml().validatePostResponseAsync({ SAMLResponse: body.SAMLResponse, RelayState: body.RelayState });
      const p: any = profile || {};
      const email: string =
        (typeof p.nameID === "string" && p.nameID.includes("@") && p.nameID) ||
        p.email || p.mail || p["urn:oid:0.9.2342.19200300.100.1.3"] || "";
      if (!email) {
        const keys = Object.keys(p).filter((k) => typeof p[k] !== "function");
        return res.status(400).send(`SAML login succeeded but no email attribute was found. Attributes: ${keys.join(", ")}`);
      }

      const first = p.firstName || p.givenName || p["urn:oid:2.5.4.42"] || "";
      const last = p.lastName || p.surname || p["urn:oid:2.5.4.4"] || "";
      const samlFull = [first, last].filter(Boolean).join(" ").trim();

      const scim = await lookupScim(email);
      const claimVals = ([] as any[])
        .concat(p.groups, p.Groups, p.memberOf, p.role, p.roles, p.Role)
        .filter((v) => v != null).flat()
        .map((v) => (v && typeof v === "object" ? v.value || v.display || "" : String(v)));
      const samlAdmin = claimVals.some((v) => isAdminGroup(v));
      const adminEmails = (process.env.ADMIN_EMAILS || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
      const emailAdmin = adminEmails.includes(email.toLowerCase());
      const role: "admin" | "viewer" = samlAdmin || scim.inAdmin || emailAdmin ? "admin" : "viewer";

      const name = samlFull || scim.displayName || p.displayName || String(email).split("@")[0];
      setCookie(res, signSession({ name, email, role, photo: scim.photo, title: scim.title, department: scim.department }), MAX_AGE);
      res.statusCode = 302;
      res.setHeader("Location", safePath(body.RelayState));
      return res.end();
    }

    return res.status(404).json({ error: "Unknown auth route." });
  } catch (e: any) {
    return res.status(400).send(`SAML error: ${e?.message || "unknown"}`);
  }
}
