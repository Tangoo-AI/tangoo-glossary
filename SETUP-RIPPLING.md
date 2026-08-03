# Connect the Tangoo Glossary to Rippling (SAML SSO)

Same approach as the Tangoo Store: the glossary runs a SAML **Service Provider**
as a Vercel serverless function (`api/auth/[...action].ts`). Users click
**Continue with Rippling** and sign in with their Tangoo account — no password.

The static app keeps a fallback email/password login when there's **no** `/api`
backend (e.g. the GitHub Pages copy), so nothing breaks. On Vercel, the Rippling
button appears automatically.

## 1. Deploy the glossary to Vercel
1. Vercel → **Add New… → Project** → import `Tangoo-AI/tangoo-glossary`.
2. Framework preset: **Other** (it's a static `index.html` + `/api` functions). No build command needed.
3. Deploy. You'll get `https://<project>.vercel.app`.
4. Add the custom domain **`glossary.tangoo.ai`** (Vercel → Settings → Domains) and point DNS to Vercel (Vercel shows the exact CNAME/A record). Rippling and the cookie need the final domain, so do this before step 3 below.

> Note: this replaces GitHub Pages as the live host — `glossary.tangoo.ai` should point at Vercel (not `tangoo-ai.github.io`).

## 2. Create the glossary's Rippling SAML app
In Rippling admin → **Custom App → SAML** (a **separate** app from the Store, because the ACS URL is different):

| Field | Value |
|---|---|
| **ACS / Recipient / Reply URL** | `https://glossary.tangoo.ai/api/auth/acs` |
| **Audience / SP Entity ID** | `https://glossary.tangoo.ai/api/auth/metadata` |
| **Start / Login URL** | `https://glossary.tangoo.ai/api/auth/login` |
| **NameID** | user **email** |
| Attributes (recommended) | `firstName`, `lastName` (and a `groups` claim if you want group-based admin) |

Or, in Rippling's "provide SP metadata" step, just give the metadata URL:
`https://glossary.tangoo.ai/api/auth/metadata`

Then copy the IdP values Rippling shows: **IdP SSO URL**, **IdP Entity ID / Issuer**, and the **X.509 signing certificate**.

## 3. Set env vars in Vercel (Settings → Environment Variables) and redeploy

| Name | Required | Value |
|---|---|---|
| `SAML_IDP_SSO_URL` | ✅ | Rippling IdP SSO URL |
| `SAML_IDP_ENTITY_ID` | ✅ | Rippling IdP entity id / issuer |
| `SAML_IDP_CERT` | ✅ | Rippling signing cert (paste the PEM; `\n` escapes are handled) |
| `SESSION_SECRET` | recommended | `openssl rand -hex 32` — signs the session cookie |
| `ADMIN_EMAILS` | to grant admin | comma-separated emails that get the Admin panel (e.g. `engji.goga@tangoo.com`) |
| `ADMIN_GROUP_NAMES` | optional | group names that map to admin (default `admin,admins,glossary admin,glossary admins`) — needs a `groups` SAML claim or SCIM |

Redeploy so the vars take effect.

## 4. Roles
- Simplest: list admins in `ADMIN_EMAILS`.
- Or send a `groups` claim from Rippling and name your admin group in `ADMIN_GROUP_NAMES`.
- Everyone else who can sign in is a regular viewer.

## How it works
- **Continue with Rippling** → `GET /api/auth/login` → redirect to Rippling → Rippling posts the signed assertion to `POST /api/auth/acs` → we set an HttpOnly, signed `tg_glossary_session` cookie → redirect home.
- On load the app calls `GET /api/auth/me`; if a session cookie exists it signs the user in (name + role) automatically.
- **Sign out** clears the cookie via `GET /api/auth/logout`.

Optional (parity with the Store): attach **Vercel KV** and set up SCIM to pull
richer profiles (photo, title, department) and group-based roles — but it's not
required for SSO to work.
