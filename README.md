# Tangoo Glossary

A self-contained, searchable glossary of every acronym, term, and bit of jargon at Tangoo — with an A–Z browse, a daily "Term of the Day", term suggestions, and an admin panel.

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

## Data

- `glossary.json` — the source list of 105 terms (acronym, term, quote, definition, category, department). Source: `Company Glossary_V3.xlsx`.
- `index.html` — the app, with the term data embedded inline. To regenerate after editing `glossary.json`, re-inject it into the `DATA = [...]` array in `index.html`.

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
