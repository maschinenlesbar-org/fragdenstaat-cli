---
name: fds-request-finder
description: >
  Find and analyse Freedom-of-Information requests on FragDenStaat.de, using the
  fragdenstaat CLI. Trigger when the user asks "how did FOI requests about
  surveillance cameras go?", "find freedom-of-information requests about lobbying",
  "which requests to the Umweltbundesamt were successful?", "show refused IFG
  requests in Bayern", "what's the success rate of requests about topic X?", or
  "recent FOI requests about police data retention". Searches by topic, filters
  precisely by status, resolution, jurisdiction, FOI law, public body, category,
  tags, dates and costs, and interprets outcomes — was a request successful,
  refused, or still open — including topic-level success-rate analysis.
version: 1.0.0
userInvocable: true
---

# FDS Request Finder

Find and **interpret** FOI requests (Informationsfreiheitsanfragen). Two modes:
**discover** a topic with full-text `request search`, then **filter precisely** with
`request list` — status, resolution, jurisdiction, law, public body, tags, dates,
costs — and read the outcome. The analysis job is usually "how did requests about X
go?": search to find the ids/tags, then count resolutions among *resolved* requests.

## Tooling

This skill drives the `fragdenstaat` command. **Before anything else, validate it is available** — run `command -v fragdenstaat` (or `fragdenstaat --version`). If it is not on your PATH, STOP and inform the user that the `fragdenstaat` CLI (`@maschinenlesbar.org/fragdenstaat-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

The API is read-only and needs **no key, account, or config**. Pass `--compact` for machine-readable JSON. Responses are Tastypie envelopes: `{"meta":{"total_count":N,"limit":L,"offset":O,"next":...,"previous":...},"objects":[...]}`; autocomplete objects are `{"value":...,"label":...}`. `--limit` is capped at **50** by the server — page with `--offset`. Anonymous access returns only **public** objects. An empty result is `{"meta":{"total_count":0,...},"objects":[]}` and exits `0` — a valid "nothing matched" answer.

## Step 1 — Discover the topic (full-text)

Start broad with `request search` to see what exists and harvest ids and tags:

```bash
fragdenstaat --compact request search --q "Überwachungskameras" --limit 50
```

`search` takes **slugs** for `--jurisdiction`/`--category` and a `--status`.
Its `meta.total_count` is **capped at 10000** — treat a value of 10000 as "at least
10000", not the exact total. For an exact count of a *filtered* set, use `request
list` (see Step 2), whose `total_count` is the true filtered total.

Harvest tag names for tighter follow-up filtering:

```bash
fragdenstaat --compact request tags "Videoüberwachung"
```

## Step 2 — Filter precisely (`request list`)

`request list` is faceted and exact. Filters take **numeric ids** (resolve names
first — see Traps):

| Flag | Filters by |
|---|---|
| `--status <s>` | lifecycle status (enum below) |
| `--resolution <r>` | outcome — only meaningful once `--status resolved` |
| `--jurisdiction <id>` | jurisdiction (numeric id) |
| `--law <id>` | FOI law (numeric id) |
| `--categories <id>` | category (numeric id — note the **plural** flag) |
| `--classification <id>` | public-body classification (numeric id) |
| `--campaign <id>` / `--project <id>` | campaign / project |
| `--public-body <id>` | addressed public body (numeric id) |
| `--tags <tag>` | tag name (from `request tags`) |
| `--reference <prefix>` | reference prefix |
| `--slug <slug>` | exact request slug |
| `--is-foi [bool]` / `--checked [bool]` / `--has-same [bool]` | genuine-FOI / moderator-checked / has identical copies |
| `--costs-min <eur>` / `--costs-max <eur>` | charged costs range |
| `--created-after` / `--created-before` | `YYYY-MM-DD` date window |
| `--offset <n>` / `--limit <n>` | paging (limit ≤ 50) |
| `--csv` | stream the server's flattened CSV export |

**status enum:** `awaiting_user_confirmation`, `publicbody_needed`,
`awaiting_publicbody_confirmation`, `awaiting_response`, `awaiting_classification`,
`asleep`, `resolved`.
**resolution enum** (only once `status=resolved`, else `""`): `successful`,
`partially_successful`, `not_held`, `refused`, `user_withdrew`, `user_withdrew_costs`.

`--status`/`--resolution` are validated client-side — an invalid value errors out
rather than silently returning nothing.

## Step 3 — Read the results

Each `objects[]` request carries the fields that matter for outcome analysis:

| Field | Meaning |
|---|---|
| `id` / `slug` | request id and url slug |
| `title` / `url` | subject line and public page |
| `status` / `readable_status` | machine status + human label |
| `resolution` | outcome — trust only when `status=resolved` |
| `jurisdiction` | jurisdiction id (`jurisdiction_name` for the label) |
| `public_body` | embedded object — read `.name` |
| `law` | FOI law id the request was filed under |
| `costs` | charged fee in EUR (`0` = free) |
| `due_date` / `resolved_on` | statutory deadline / resolution date |
| `tags` | tag list — reuse to widen or tighten the set |
| `created_at` | filing date |

`meta.total_count` is the real filtered total; only `--limit` (≤ 50) come back per
page — page with `--offset`. Fetch one request in full, including its complete
`messages[]` correspondence thread, with `request get <id>`.

> **Traps.**
> - Filters take **numeric ids**, not names. Resolve first: get a public-body id
>   from the authority-lookup skill / `publicbody autocomplete`, a jurisdiction/law/
>   category id from the relevant `... list --q` or `... autocomplete`. Note the
>   **plural** `--categories` and the hyphenated `--public-body`.
> - `resolution` is `""` until `status=resolved`. Always pass `--status resolved`
>   before trusting or counting resolutions — an open request has no meaningful
>   outcome.
> - `--limit` maxes at **50**; page with `--offset`. `list`'s `total_count` is the
>   true filtered total; only `search`'s is capped (at 10000).
> - Only **public** requests are visible anonymously. A success rate is computed
>   over the public set — state that caveat.

## Step 4 — Analyse an outcome (worked example)

"What's the success rate of requests about video surveillance?" — discover, then
count resolutions among *resolved* requests. Use `request tags` / `search` to find
the right tag, then compare resolution buckets:

```bash
# Total resolved requests carrying the tag (read meta.total_count):
fragdenstaat --compact request list --tags "Videoüberwachung" --status resolved --limit 1

# Successful ones:
fragdenstaat --compact request list --tags "Videoüberwachung" \
  --status resolved --resolution successful --limit 1

# Refused ones:
fragdenstaat --compact request list --tags "Videoüberwachung" \
  --status resolved --resolution refused --limit 1
```

Each call's `meta.total_count` is the bucket size — no paging needed just to count.
Success rate ≈ (`successful` + `partially_successful`) / resolved total. For a
public body's track record, swap `--tags` for `--public-body <id>` (resolve the id
first). Report the counts, the rate, and note it covers only public requests.

For bulk analysis (pivot in a spreadsheet or pandas), stream the flattened CSV
instead of paging JSON:

```bash
fragdenstaat request list --tags "Videoüberwachung" --status resolved --csv -o requests.csv
```

Confirm the output path before writing, and report the row count after.

## Republication note

Requests contain personal data. For anything you republish, prefer the request's
`redacted_description` (a list of `[isRedacted, text]` segments) and redacted
attachments over raw text. The data license is mixed — authority answers are
presumed public-domain *amtliche Werke*, user texts are CC0 — so we provide the
tool, not the data.
