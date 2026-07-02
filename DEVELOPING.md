# Developing `fragdenstaat-cli`

A TypeScript client + CLI for the public, read-only endpoints of the
**FragDenStaat.de** API — Germany's Freedom-of-Information portal (software:
[Froide](https://github.com/okfde/froide), operator: Open Knowledge Foundation
Deutschland). This document covers the architecture and the API-specific details
that matter when editing it. For domain terms see [GLOSSARY.md](GLOSSARY.md); for
data terms see [DATA_LICENSE.md](DATA_LICENSE.md).

## Commands

```bash
npm install
npm run build       # tsc -> dist/
npm run typecheck   # tsc --noEmit
npm test            # pretest builds, then `node --test dist/test/*.test.js`
npm start -- --help # run the built CLI
npm run docs        # TypeDoc -> out/
```

Run one test file after building: `node --test dist/test/cli.test.js`.

## Architecture

Two layers, two seams — the same blueprint as the sibling `*-cli` repos.

```
src/
  client/        # typed API client, usable as a library on its own
    types.ts     # Tastypie envelope + typed list-item interfaces
    enums.ts     # request status/resolution, message kind, region kind
    query.ts     # dependency-free query-string builder
    http.ts      # Transport interface + default node:http/https transport
    engine.ts    # URL building, retry/backoff, JSON decode, error mapping
    errors.ts    # FdsError / FdsApiError / FdsNetworkError / FdsParseError
    params.ts    # per-endpoint filter interfaces
    client.ts    # FragDenStaatClient — resource groups over the engine
    index.ts
  cli/
    io.ts        # injectable I/O + client factory (CliDeps / CliIO)
    shared.ts    # option parsers, global-option -> EngineOptions, render helpers
    commands/    # one file per resource group + a small `common.ts` helper
    program.ts   # assembles the commander program from injectable deps
    run.ts       # parses argv -> exit code (no process.exit; testable)
    index.ts     # #! bin shim
  index.ts       # library entry
```

**Two seams make it testable in-process (no subprocesses):**

- **`Transport`** (`http.ts`) — a single `(HttpRequest) => Promise<HttpResponse>`.
  The default uses `node:http`/`https`; tests inject a recording mock. This is the
  only HTTP seam.
- **`CliDeps`** (`io.ts`) — a client factory + I/O object (`out`/`err`/`writeFile`/
  `outBinary`). `run.ts` returns an exit code instead of calling `process.exit`, so
  tests drive the whole CLI with a mocked client and captured output.

Zero runtime HTTP dependencies (built on `node:http`/`https` — no axios/fetch).
The CLI's only runtime dependency is `commander`. Strict TS, ESM (`NodeNext`).

## API-specific details (read this before "aligning" with the blueprint)

FragDenStaat is **not** shaped like the other repos' APIs. The provided OpenAPI
schema (`fragdenstaat.de.yaml`, drf-spectacular) does **not** match what the server
actually serves; everything below was verified empirically against the live API.
When in doubt, trust the live API, not the schema.

- **Wire format is Tastypie, not DRF.** List responses are a `{ meta, objects }`
  envelope — `meta = { limit, offset, total_count, next, previous }`, `objects` is
  the array. Detail responses are the bare object. This is typed as `TastypieList<T>`
  in `types.ts`, **not** the `{ count, next, previous, results }` the schema claims.
- **Related resources are hyperlinked** as absolute `resource_uri` URLs, not embedded
  (a request's `public_body` is a nested exception; detail responses inline
  `law`/`public_body`/`messages`). List items are typed for the common scalar fields;
  nested/free-form sub-objects and all detail responses are `JsonValue`/`JsonObject`.
- **`limit` is hard-capped at 50** by the server (anything larger, and `limit=0`, is
  silently clamped). The CLI enforces `--limit 1..50` client-side (`addPagination`)
  and users page with `--offset`. Search endpoints additionally cap `total_count` at
  10000.
- **Trailing slashes are mandatory** — a slashless path 301-redirects (Django
  `APPEND_SLASH`). Every client path ends in `/`, and the engine does **not** follow
  redirects (a 3xx surfaces as an `FdsApiError`), so this matters. `http://`
  likewise 301s to `https://`.
- **CSV is a first-class server feature.** `?format=csv` (with `Accept: text/csv`)
  returns a flattened CSV (nested objects become dotted columns). Exposed as `--csv`
  on `list`/`search` commands via `client.<resource>.listCsv()` (`getRaw`). Note:
  `?format=csv` combined with an `Accept: application/json` header 406s, so the CSV
  path negotiates `Accept: text/csv` explicitly. `format=xml` 404s everywhere;
  `format=jsonp` works on some resources only — neither is wrapped.
- **Two error-body shapes** (`engine.ts` handles both):
  `{"detail": "<message>"}` for 404/406/format errors, and
  `{"<field>": ["<message>", ...]}` for 400 validation errors (keyed by the offending
  filter). Messages are German. `error_message`/`error` (Tastypie 500s) are a further
  fallback.
- **No API key, no auth.** Every data resource returns public objects anonymously
  (only `/api/v1/user/` is auth-gated, and it is not wrapped). Anonymous responses are
  inherently filtered to public objects; message drafts are excluded and
  `content_hidden` messages come back with blanked content.
- **No published rate limit** and **no `Retry-After`** header. The engine still
  retries transient `429`/`503` with linear backoff (defensive), and sends a
  descriptive `User-Agent` (`fragdenstaat-cli`). Be a good citizen when paging.
- **Filter-name quirks** (verified live): `request list` uses **plural**
  `--categories` and `--public-body`; `publicbody list` uses **singular** `--category`
  (plural is ignored) and distinguishes `--classification` (subtree) from
  `--classification-id` (exact). `document --tag` needs a numeric tag id, while
  `request --tags` takes a tag-name string.

## Scope

Ten resource groups are wrapped — the public, useful read surface: `request` (+
search, tag autocomplete), `publicbody` (+ search, autocomplete), `law` (+
autocomplete), `jurisdiction`, `category` (+ autocomplete), `classification`,
`campaign`, `georegion` (+ autocomplete), `message`, `document`. Deliberately **not**
wrapped: write/OAuth endpoints, the auth-gated `user` resource, and niche/irregular
read resources (`attachment`, `following`, `documentcollection`, `documentportal`,
`page`, `pageannotation`, `problemreport`, `governmentplan`, `articletag`,
`campaigninformationobject` — the last requires `?campaign=<id>` and 500s for some
ids, `venue`, `feature`). They can be added later if a use case appears.

## Testing

Node's built-in test runner (`node:test`), no jest/vitest. `test/helpers.ts` builds
canned responses and a recording mock transport; `test/fixtures.ts` holds Tastypie
sample bodies. `http.test.ts` exercises the real transport against a local
`http.createServer`. `cli.test.ts` drives `run()` end-to-end with a mocked client.
Tests must keep passing on Node 20/22/24.

## CI / release

`.github/workflows/`: `ci.yml` (typecheck + build + test on Node 20/22/24),
`release.yml` (on a `v*` tag: test, `npm pack`, CycloneDX SBOMs, GitHub Release),
`publish.yml` (manual npm publish via OIDC trusted publishing), `docs.yml` (TypeDoc
→ GitHub Pages). The npm tarball ships only `dist/src` + `LICENSING.md` +
`CONTRIBUTING.md` (see `package.json` `files` and `.npmignore`); `skills/`,
`.claude-plugin/`, tests and the spec are excluded.
