# Tangoo Glossary

**Live:** https://tangoo-ai.github.io/tangoo-glossary/ (custom domain https://glossary.tangoo.ai/ pending DNS)

A self-contained, searchable glossary of every acronym, term, and bit of jargon at Tangoo — with an A–Z browse, term suggestions, and an admin panel. Data is read live from a shared Google Sheet.

## Run it

It's a single static file. Either:

- **Open directly:** double-click `index.html`, or
- **Serve locally:**
  ```bash
  node server.js        # serves on http://localhost:5180 (set PORT to change)
  ```

No build step, no dependencies.

## Features

- **Search** — live, as-you-type filtering across acronym, term, and definition, with an autocomplete dropdown.
- **Browse A–Z** — sticky letter rail with a sliding active indicator; empty letters are greyed out.
- **Cross-links** — terms mentioned inside a definition link to their own card automatically.
- **Term of the Day** — a no-repeat daily rotation through all terms (admins can override any date).
- **Suggest a term** — anonymous by default; attributed to your name when signed in.
- **Admin panel** (`#admin`) — Term of the Day overrides, analytics (most-searched, zero-result searches, most-viewed), suggestions queue (approve/reject/edit), full term CRUD, and user management.

## Data — connected to a Google Sheet

The glossary is driven by a shared Google Sheet. **Add or edit a row in the sheet, refresh the app, and the change appears** — no redeploy needed.

- Sheet: `https://docs.google.com/spreadsheets/d/1OJfSO7H-y67WPcArYdztveqDJIEmzF3e0rhFwK5Vo10/edit`
- The app reads it live on load via `.../gviz/tq?tqx=out:csv` and uses only these columns: **Acronym, Term, Quote, Definition, Category, Department** (other columns like Asset Link, Last Updated, Status, Rarity, Collection are ignored). Cells that contain a spreadsheet formula are treated as empty.
- The sheet must stay **"anyone with the link can view"** for the live fetch to work.
- **Fallback:** `glossary.json` / the `DATA = [...]` array embedded in `index.html` is a snapshot used when the live fetch is blocked (offline, `file://`, or a strict-CSP host like the claude.ai artifact preview). To refresh the snapshot, re-export the sheet and re-inject it into `DATA`.

> Note: the live connection is a read-only, client-side fetch. Anyone who can open the app can read the sheet's shared data — for private, access-controlled data you'd move the fetch behind a backend.

## ⚠️ Current limitations (important)

This is a **frontend-only preview**. All state — user accounts, sessions, suggestions, analytics, and term edits — lives in the browser's `localStorage`, which means:

- Data is **per-browser and not shared** between people.
- Authentication is **not real security** (passwords are hashed client-side; there is no server enforcing access).
- The seed admin account (`engji.goga@tangoo.com` / `tangoo-admin`) and a demo-credentials hint exist purely to make the preview explorable — **remove these before any real deployment.**

**Next step:** port the data layer and auth to a backend (e.g. Node + a database) so accounts, suggestions, analytics, and term edits are shared, persistent, and properly secured.

## Structure

| File | Purpose |
|------|---------|
| `index.html` | The entire app (HTML + CSS + JS + embedded data) |
| `glossary.json` | Source term data |
| `server.js` | Minimal Node static server for local preview |
| `.claude/launch.json` | Local dev-server config |
