---
name: fds-authority-lookup
description: >
  Find and profile the right German public body (Behörde) to address an FOI
  request to, using the fragdenstaat CLI. Trigger when the user asks "which
  authority handles environmental data in Hamburg?", "find the Behörde for X",
  "what's the FOI contact email for the Umweltbundesamt?", "how many FOI requests
  has this ministry answered?", "who do I ask about building permits in Munich?",
  "list all Grundschulen public bodies", or wants an authority's address, type,
  jurisdiction, request_note, or activity level. Resolves names to numeric ids,
  filters by jurisdiction / classification / category / region / proximity, and
  hands the body id to the request-finder to inspect its FOI track record.
version: 1.0.0
userInvocable: true
---

# Authority (Behörde) Lookup

Help the user find the **right public body to file an FOI request with** — and
profile it: its FOI contact, address, type, jurisdiction, activity, and how it
wants to be contacted. Most jobs are: name → id (autocomplete), then `get` for the
full profile, or a faceted `list`/`search` to discover bodies by topic and place.

## Tooling

This skill drives the `fragdenstaat` command. **Before anything else, validate it is available** — run `command -v fragdenstaat` (or `fragdenstaat --version`). If it is not on your PATH, STOP and inform the user that the `fragdenstaat` CLI (`@maschinenlesbar.org/fragdenstaat-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

The API is read-only and needs **no key, account, or config**. Pass `--compact` for machine-readable JSON. Responses are Tastypie envelopes: `{"meta":{"total_count":N,"limit":L,"offset":O,"next":...,"previous":...},"objects":[...]}`; autocomplete objects are `{"value":...,"label":...}`. `--limit` is capped at **50** by the server — page with `--offset`. Anonymous access returns only **public** objects. An empty result is `{"meta":{"total_count":0,...},"objects":[]}` and exits `0` — a valid "nothing matched" answer.

## Step 1 — Name in hand? Resolve it to an id

If the user names a specific authority, go straight to autocomplete — fastest
name → id:

```bash
fragdenstaat --compact publicbody autocomplete "Umweltbundesamt"
```

Each hit is `{"value":<id>, "label":<name>}`. Take the `value` (numeric id) and
fetch the full profile:

```bash
fragdenstaat --compact publicbody get 123
```

## Step 2 — No name yet? Discover by topic + place

When the user describes a *kind* of body in a *place* ("environmental data in
Hamburg", "building permits in Munich"), you filter — but the filters take
**numeric ids**, so resolve first:

- **Jurisdiction** (Bund / a Land / EU) → `fragdenstaat jurisdiction list` (18
  rows), take the id.
- **Type of body** (Ministerium, Grundschule, Polizei…) → `fragdenstaat
  classification list --q "<type>"`, take the id.

Then filter with `publicbody list` (faceted) or `publicbody search` (full text):

```bash
# Behördentyp id, then all public bodies of that type in a jurisdiction
fragdenstaat --compact classification list --q "Ministerium"
fragdenstaat --compact publicbody list --classification 42 --jurisdiction 7 --limit 50

# Full-text search restricted to a jurisdiction
fragdenstaat --compact publicbody search --q "Umwelt" --jurisdiction 7 --limit 50

# Nearest bodies to a point (Munich Marienplatz) — note lng,lat order
fragdenstaat --compact publicbody list --lnglat "11.5755,48.1372" --limit 20
```

## Step 3 — Read the profile

`objects[]` (list/search) and the single `get` object carry what matters:

| Field | Meaning |
|---|---|
| `id` / `slug` | numeric id (for filtering/bridging) and the URL slug |
| `name` | official name of the authority |
| `jurisdiction` | Bund / Land / EU it belongs to |
| `classification` (`.name`) | Behördentyp (Ministerium, Grundschule…) |
| `categories` | topical tags attached to the body |
| `email` | **the FOI intake address** — where a request is sent |
| `contact` | contact block (phone, contact person) |
| `address` / `fax` | postal address and fax |
| `url` / `site_url` | the body's own site / its FragDenStaat page |
| `request_note` | how they *want* to be contacted — read before filing |
| `number_of_requests` | FOI activity signal (how busy / responsive) |

## Step 4 — Bridge to its FOI track record

Once you have the body id, hand it to the **request-finder** to see what it has
actually answered:

```bash
fragdenstaat --compact request list --public-body 123 --status resolved
```

That surfaces this body's resolved requests (and with `--resolution successful`,
its wins) — a concrete read on responsiveness beyond `number_of_requests`.

> **Traps.**
> - **`publicbody` uses SINGULAR `--category`** — a plural `categories` flag does
>   not exist here and is silently ignored. (The *request* commands use
>   `--categories`; don't carry that habit over.)
> - **`--classification` vs `--classification-id` differ.** `--classification`
>   matches the whole **subtree** under a Behördentyp (e.g. all ministries);
>   `--classification-id` is an **exact** single-node match. Pick deliberately.
> - **IDs are numeric.** Resolve jurisdiction / classification / category names to
>   ids via `jurisdiction list` / `classification list --q` / `category
>   autocomplete` first; passing a name string won't filter.
> - **`--lnglat` is `lng,lat`** (longitude first) — the reverse of the usual
>   spoken "lat, long". Swapping them lands you in the wrong hemisphere. (The
>   `georegion --latlng` flag is the *other* order — `lat,lng` — don't conflate.)
> - **`--limit` maxes at 50.** For "list all Grundschulen" style asks, page with
>   `--offset 50`, `--offset 100`, … until `objects` empties; report the honest
>   `meta.total_count`.

## Step 5 — Present it

For a "who do I ask / what's their contact" request, lead with the actionable bits:

```
Umweltbundesamt (id 123 · slug umweltbundesamt)
  Typ:          Bundesoberbehörde        Zuständig: Bund
  FOI-Kontakt:  info@uba.de
  Adresse:      Wörlitzer Platz 1, 06844 Dessau-Roßlau
  Hinweis:      <request_note verbatim — how they want to be contacted>
  Aktivität:    412 Anfragen bisher       Seite: fragdenstaat.de/behoerde/umweltbundesamt

To file: FragDenStaat sends the request under the applicable IFG/UIG law on your
behalf — open the "Seite" link above and use "Anfrage stellen".
```

Rules:
- **Lead with `email` and `request_note`** — that pair is what the user needs to
  actually file. Quote `request_note` verbatim; some bodies demand a specific
  form, portal, or postal-only route.
- Give the `id` alongside — it's the handle for Step 4 and any follow-up.
- Cite `number_of_requests` as an activity signal, not a promise; for real
  responsiveness offer the Step 4 `request list … --status resolved` bridge.
- When several bodies match, list a few with id · Typ · jurisdiction and ask which,
  rather than guessing — and state `meta.total_count` so the user knows the scope.
- Don't invent an email or address: if a field is empty, say so and point to the
  `site_url` page instead.
