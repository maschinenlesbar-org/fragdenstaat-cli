---
name: fds-document-digger
description: >
  Find and bulk-export documents released through FOI on FragDenStaat.de, scoped by
  authority, request, collection or portal, and export request and document datasets
  to CSV for analysis. Trigger when the user asks "find documents published by the
  Umweltbundesamt", "documents from FOI request 12345", "export FOI requests about
  lobbying to CSV", "get the document collection for portal X", "download a dataset
  of environmental FOI documents", "which documents came out of campaign Y?", or wants
  the OCR'd files, page counts and file URLs behind released requests. Resolves
  authority and campaign names to numeric ids first, then filters and pages the
  document/request datasets and streams the server's flattened CSV export.
version: 1.0.0
userInvocable: true
---

# FragDenStaat Document Digger

The data-extraction skill: locate **published** FOI documents (often scanned/OCR'd
files released by an authority) and export request or document **datasets to CSV**
for analysis. Scope by authority, request, collection, portal, directory, tag or date.

## Tooling

This skill drives the `fragdenstaat` command. **Before anything else, validate it is available** — run `command -v fragdenstaat` (or `fragdenstaat --version`). If it is not on your PATH, STOP and inform the user that the `fragdenstaat` CLI (`@maschinenlesbar.org/fragdenstaat-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

The API is read-only and needs **no key, account, or config**. Pass `--compact` for machine-readable JSON. Responses are Tastypie envelopes: `{"meta":{"total_count":N,"limit":L,"offset":O,"next":...,"previous":...},"objects":[...]}`; autocomplete objects are `{"value":...,"label":...}`. `--limit` is capped at **50** by the server — page with `--offset`. Anonymous access returns only **public** objects. An empty result is `{"meta":{"total_count":0,...},"objects":[]}` and exits `0` — a valid "nothing matched" answer.

## Step 1 — Resolve names to numeric ids first

Every `document list` scope filter (`--publicbody`, `--collection`, `--portal`,
`--foirequest`, `--directory`, `--tag`) is a **numeric id**, never a name. Look the
id up before filtering:

- **Authority** → `fragdenstaat publicbody autocomplete "Umweltbundesamt"` — each
  hit is `{"value":<id>,"label":...}`; take the `value`.
- **Document tag** → `document list --tag` needs a **numeric tag id**; a bare tag
  string is rejected with a 400 (see Traps).
- **Campaign** (indirect) → `document list` has **no** `--campaign`. Reach a
  campaign's documents *through its requests*: `fragdenstaat campaign list --limit 50`
  (only ~18 campaigns, no `--q`/autocomplete — read the `id` off the matching name),
  then `fragdenstaat request list --campaign <id>` for its requests, then
  `document list --foirequest <request-id>` per request.

```bash
fragdenstaat --compact publicbody autocomplete "Umweltbundesamt"
```

## Step 2 — Filter the document dataset

```bash
fragdenstaat --compact document list --publicbody 123 --limit 50
```

`document list` filters (all repeatable-free, all id-based except the dates):

| Flag | Scope |
|---|---|
| `--publicbody <id>` | documents published by this authority |
| `--foirequest <id>` | documents released by one FOI request |
| `--collection <id>` | a curated document collection |
| `--portal <id>` | a document portal |
| `--directory <id>` | a directory within a collection/portal |
| `--tag <id>` | **numeric** tag id (not a tag string) |
| `--ids <id,id,...>` | an explicit comma-separated document-id set |
| `--created-after <YYYY-MM-DD>` | created on/after this date |
| `--created-before <YYYY-MM-DD>` | created on/before this date |
| `--limit <1..50>` / `--offset <n>` | page (max 50 per JSON page) |

`fragdenstaat document get <id>` returns one document in full, including its
`pages[]`, `num_pages`, `file_url` and `file_size`.

Key `objects[]` fields:

| Field | Meaning |
|---|---|
| `id` | document id — what `--ids` / `get` reference |
| `title` / `slug` | label and URL slug |
| `description` | free-text description |
| `foirequest` | source request id (nullable) |
| `publicbody` | publishing authority id |
| `num_pages` | page count (OCR'd docs) |
| `file_url` | **URL to the raw file on the server** (metadata only — see Traps) |
| `file_size` | bytes |
| `site_url` | human page on fragdenstaat.de |
| `published_at` | publication timestamp |
| `public` / `listed` | visibility flags |

> **Traps.**
> - **`document --tag` needs a numeric tag id.** A free-text tag string
>   (`--tag lobbyism`) is rejected with a **400**. This differs from `request --tags`,
>   which takes a tag *name* string (e.g. `request list --tags lobbyismus`);
>   `fragdenstaat request tags "lob"` autocompletes those request tag **names**
>   (`{"value":"lobbyismus",...}` — a string, not a document-tag id).
> - **All `document list` scope ids are numeric.** Resolve authority/collection/portal
>   names to ids (Step 1) — passing a name silently matches nothing or 400s.
> - **No `--campaign` on `document list`.** Go via requests (Step 1, Campaign).
> - **`--limit` maxes at 50 on the JSON path.** For a *full* dataset use `--csv`
>   (Step 3); it streams every matching row server-side. For very large pulls still
>   page with `--offset`, or read `meta.total_count` to size the export first.
> - **The CLI returns metadata/URLs, not the binary.** `file_url` points at the raw
>   file on the server; downloading it (e.g. `curl "$file_url" -o doc.pdf`) is a
>   separate step the CLI does not perform.
> - **CSV columns for nested fields are dotted** (e.g. `public_body.name`,
>   `foirequest.id`) — the server flattens nested objects into dotted column names.

## Step 3 — Export a dataset to CSV

Both `document list` and `request list` accept `--csv` to stream the
**server-rendered, flattened CSV export** — the right tool for spreadsheets/pandas
and for pulling a whole dataset past the 50-row JSON cap. Combine with `-o <file>`.

**This is a file-writing step. Before writing:** echo the resolved output path and,
if the file already exists, confirm before overwriting rather than clobbering it
silently. **After writing:** report what was written — the CLI prints
`Wrote N bytes to <path>` to stderr; surface that plus the row count.

```bash
# All documents from one authority -> CSV
fragdenstaat document list --publicbody 123 --csv -o authority-docs.csv

# All FOI requests about a topic -> CSV (request list, same --csv path)
# request --tags takes a tag NAME (string), not an id:
fragdenstaat request list --tags lobbyismus --created-after 2024-01-01 --csv -o lobbying-requests.csv
```

## Worked example — export all documents from one authority

1. Resolve the authority id:
   `fragdenstaat --compact publicbody autocomplete "Umweltbundesamt"` → `value: 123`.
2. Size the pull (optional): `fragdenstaat --compact document list --publicbody 123 --limit 1`
   and read `meta.total_count`.
3. Confirm the output path (`./authority-docs.csv`); if it exists, ask before
   overwriting.
4. Export:
   `fragdenstaat document list --publicbody 123 --csv -o authority-docs.csv`.
5. Report: e.g. "Wrote 412 documents (287 KB) to `./authority-docs.csv`" — count the
   data rows (subtract the header line) and echo the byte size the CLI reported.

## Republication note

Documents can carry personal data. For anything intended for **republication**,
prefer the redacted variants (a request's `redacted_description` — a list of
`[isRedacted, text]` segments — and redacted attachments) over raw text. The data
license is mixed (authority answers presumed public-domain *amtliche Werke*; user
texts CC0) — we provide the tool, not the data.
