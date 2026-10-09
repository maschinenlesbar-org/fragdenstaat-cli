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
npm test            # pretest builds, then `node --test --test-timeout=5000 dist/test/*.test.js`
npm start -- --help # run the built CLI
npm run docs        # TypeDoc -> out/ (first: npm ci --prefix tools/docs)
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
    errors.ts    # FdsError / FdsApiError / FdsNetworkError / FdsParseError / FdsValidationError
    validate.ts  # Problem rules + assertValid (input checks shared with the CLI)
    params.ts    # per-endpoint filter interfaces
    client.ts    # FragDenStaatClient — resource groups over the engine
    index.ts
  cli/
    io.ts        # injectable I/O + client factory (CliDeps / CliIO), the logger and the clock
    log.ts       # the stderr log: records with ts, level, topic; --log-format text|jsonl
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
  only HTTP seam. The engine holds every transport to the same contract, so a custom
  one (a `fetch` adapter, a test double) needs none of it itself: each call runs under
  the overall `timeoutMs` deadline (the request carries an `AbortSignal`,
  `HttpRequest.signal`, that fires then, and the call rejects at the deadline whether
  the transport stops or not); `maxResponseBytes` is checked on the body it returns
  (`Response exceeded the size limit of N bytes (maxResponseBytes;
  --max-response-bytes on the CLI)`); headers may come as a plain record in any case,
  a `Headers` object or a `Map`; the body may be a `Buffer`, any `ArrayBuffer` view or
  an `ArrayBuffer` (from any realm). Whatever else a transport throws or returns — a
  plain `Error`, a string, `null`, a response without a valid status — becomes an
  `FdsNetworkError` (URL redacted, the original as `cause`).
- **Decoding.** A JSON body is decoded by the charset its `Content-Type` declares
  (UTF-8 when it names none) with `TextDecoder` (`decodeBody`), which also drops a
  leading byte order mark; an unknown charset label is an `FdsParseError`. CSV
  downloads stay raw bytes.
- **`CliDeps`** (`io.ts`) — a client factory + I/O object (`out`/`err`/`writeFile`/
  `outBinary`). `run.ts` returns an exit code instead of calling `process.exit`, so
  tests drive the whole CLI with a mocked client and captured output. The bin shim
  (`cli/index.ts`) installs `handleOutputErrors` before `run()`: an EPIPE on stdout
  (`| head`) exits 0 quietly instead of Node's unhandled-`error` stack trace and exit
  1; an EPIPE on stderr is ignored, so a failed run keeps its exit code; any other
  write error exits 1. `test/conformance-p7-pipes-exit-codes.test.ts` runs the built
  bin through real pipes.

Zero runtime HTTP dependencies (built on `node:http`/`https` — no axios/fetch).
The CLI's only runtime dependency is `commander`. Strict TS, ESM (`NodeNext`).

## Input validation

The library owns every rule about what a request may contain, and checks it before
sending anything. A rule is a pure `Problem` function in `client/validate.ts`: it
returns the reason a value is invalid, or `undefined`. Client methods enforce it with
`assertValid(name, value, problem)`, which throws `FdsValidationError` (a subclass of
`FdsError`) with the message `Invalid <name>: <reason>`; methods that return a promise
reject with it, and no request is sent. The CLI's commander parsers call the same
functions and turn the reason into a usage error (exit 1, commander's usage exit code),
and `run.ts` maps an `FdsValidationError` raised inside an action to exit 1 as well,
logged as an `ERROR` record of `fragdenstaat.cli`. So the CLI and the library reject the same inputs, and
`test/helpers.ts`'s `parity()` checks that: it runs one input through `run()` and through
the library on one recording mock transport and returns both outcomes.

What the library rejects with `FdsValidationError`, before any request:

- **Blank values.** A query value (or array element) that is `""` or only whitespace,
  and a blank parameter name, on every request (`assertNonBlankParams`, run by
  `RequestEngine.request`). The API treats an empty parameter as no filter and answers
  with the whole unfiltered dataset, or every autocomplete suggestion for a blank `q`.
  `undefined` and `null` still mean "omitted". The CLI's `parseNonEmpty` uses the same
  `nonBlankProblem`. An invalid `Date` (`new Date("nope")`) is refused the same way
  (`Expected a valid date.`) instead of throwing a raw `RangeError` from `toISOString`.
- **An autocomplete without a query.** Every `autocomplete(q)` (and
  `requests.tagsAutocomplete`) needs `q` as a non-blank string (`queryTextProblem`);
  `undefined` or `null` used to send no `q` at all, which the API answers with every
  suggestion.
- **Bad engine options.** A numeric option outside its range (`timeoutMs`,
  `maxRetries`, `retryDelayMs`, `maxResponseBytes`) is an `FdsValidationError`
  (`Invalid option <name>: …`), like a bad `baseUrl` or `userAgent`; `null` options
  count as none. Every failure the library raises is an `FdsError` subclass; server
  text in a message (an error `detail`, a redirect target) is cut at 500 characters
  (`MAX_DETAIL_LENGTH`), and so is a URL or path (`cutForMessage`,
  `MAX_MESSAGE_VALUE_LENGTH`; also a value quoted in a validation message, an unknown
  charset, the Content-Type in the CLI's `Wrote …` note and a name filter in the
  empty-result note), never inside a surrogate pair (`cutText`), so the message stays
  well-formed and bounded for a library caller too, while
  `FdsApiError.body` and `.url` keep the full text.
- **Non-numeric ids.** `get(id)` takes a non-negative safe integer or a digit string
  (`resourceIdProblem`, `normalizeResourceId`); `"search"` or `"autocomplete"` would
  otherwise reach a list sub-endpoint and return its list envelope as a detail object,
  and `""`, `" 10 "`, `1.5`, `-1` or `NaN` would fail late on the server. A digit
  string beyond `Number.MAX_SAFE_INTEGER` (`"99999999999999999999"`) is refused too,
  as for the id filters.
- **Filters the API would ignore or drop (strict filters).** Every `list`, `listCsv`,
  `search` and `searchCsv` call checks its params object against its endpoint's table
  in `filters.ts` (`assertParams`; tables such as `REQUEST_LIST_PARAMS`, from Froide's
  FilterSets and checked live). Refused, with an `FdsValidationError`:
  - an **unknown key** (own keys only, so a JSON `__proto__` or `constructor` too), with
    a "did you mean" (`jurisdicton`, `Status`, `category` on `publicBodies.search`,
    `is_topic` on `classifications.list`): the API ignores it and answers with the
    unfiltered set. `{ allowUnknownFilters: true }` as the call's second argument sends
    a key the table doesn't know (a scalar or a list of scalars);
  - a **list where the API reads one value**: Django keeps only the last of repeated
    keys, so `jurisdiction: [1, 91]` counted Baden-Württemberg alone (11 606) and
    `[91, 1]` the Bund alone (175 330). Arrays are taken only by the multiple-choice
    filters, sent as repeated keys (public-body `category`, public-body search
    `regions`), and by the comma lists below;
  - a **wrong value type or domain**: id filters (`jurisdiction`, `law`, `public_body`,
    `publicbody`, `foirequest`, `parent`, `ancestor`, …) take a non-negative integer or
    its digit string and are sent as numbers (`idFilterProblem`); `depth` and `level` a
    non-negative integer; enum filters the `enums.ts` arrays (`oneOfProblem`); boolean
    filters a real boolean (`booleanProblem`); text filters a non-blank string; dates a
    string or a valid `Date`. Request `campaign` also takes `"-"`, Froide's "no campaign";
  - a **malformed id list** (`document ids`, georegion `id`, public-body `regions`;
    `idListProblem`): Froide converts each element with `int()` and drops the whole
    filter when one fails, so `ids=26,abc` or `ids=26;27` returned all 259 575
    documents, with document 26 first. A valid list is sent canonical
    (`"26, 27"` → `26,27`; `[26, 27]` works too). `regions=abc` made the server answer
    HTTP 500.

  The CLI's parsers use the same rules (`parseIdFilter`, `parseIdList`, `parseIntArg`,
  `choiceOption`, `asBool`), so a bad value is a usage error before any request, and a
  repeated single-value option is a usage error (`once`); only `document list --ids`
  collects repeats into one list.
- **Out-of-range paging.** Every list, search and autocomplete method checks `limit`
  (an integer in `1..MAX_PAGE_SIZE`, `limitProblem`) and `offset` (a non-negative safe
  integer, `offsetProblem`). The server silently clamps a larger `limit` and `limit=0`
  to 50, so a caller asking for 100 rows would get 50 without an error. `MAX_PAGE_SIZE`
  (`params.ts`) is also the bound the CLI's `--limit` and its CSV page note use.
- **Malformed points.** Georegion `latlng` and publicbody `lnglat` (on `list`, `listCsv`,
  `search` and `searchCsv`) must be two comma-separated decimals, latitude within ±90
  and longitude within ±180 in the parameter's order (`pointProblem`).
- **A bad `userAgent`.** The `RequestEngine` constructor (so `new FragDenStaatClient()`)
  throws for a blank value, a control character other than tab (CR/LF would inject a
  header into a custom transport), DEL or a code point above U+00FF
  (`headerValueProblem`); only an omitted `userAgent` selects the default. The CLI's
  `--user-agent` (`parseHeaderValue`) uses the same rule. As a backstop the default
  transport turns Node's synchronous header-validation `TypeError` into an
  `FdsNetworkError` (`Invalid request: ...`).
- **A malformed `baseUrl`.** The constructor checks the raw value, before stripping
  trailing slashes (`validateBaseUrl`, rule `baseUrlProblem`): no surrounding
  whitespace and no whitespace or control character inside it (`baseUrlSpaceProblem`;
  `new URL()` trims and drops such characters, so the URL check passed while request
  paths were appended to the raw string and `"https://h/ "` requested
  `/%20/api/v1/...`), parseable, an `http:`/`https:` scheme, no query or fragment
  (paths are appended as a string, so `?`/`#` would swallow every path), and no `%` in
  the user name or password that doesn't start an escape (Node decodes the userinfo for
  the Authorization header and failed at request time with "URI malformed"; a literal
  `%` is `%25`). Userinfo is
  allowed (Basic auth for a protected mirror) and redacted in every message (see
  "Credential redaction" below). This is a configuration error, so it is an `FdsValidationError`, not the transport's
  `FdsNetworkError`. The CLI's `parseBaseUrl` calls the same `baseUrlProblem`, with the
  same reasons.
- **Non-numeric law id filters and bad cost amounts.** `laws.list`/`listCsv` take
  `jurisdiction`, `mediator` and `id` only as a non-negative integer or a digit string
  (`idFilterProblem`) and send them as numbers (`normalizeIdFilter`, `"007"` becomes
  `7`); the API ignores a non-numeric value there and returns every law. Request
  `costs_min`/`costs_max` must be finite non-negative numbers (`amountProblem`), which
  the server would otherwise answer with HTTP 400. The CLI's `parseIdFilter` and
  `parseNonNegativeNumber` use the same rules.

**Credential redaction.** A credential in the base URL never reaches the output. The
CLI redacts on output: `run.ts` (`withRedactedOutput`) takes the exact userinfo of every
argument (`credentialsIn`, exported) and replaces it with `***` in everything it prints —
commander's usage errors, which echo rejected values (`argument '<url>' is invalid`,
`unknown command '<url>'`), and the help that follows them — so a password with spaces,
quotes, `#`, `?` or `/` is caught as well as an ordinary one. `redactUrl` falls back to
the same text-based cut (`redactCredentials`) for a value that doesn't parse as a URL.
In the library, the engine keeps the base URL in a real `#private` field, so
`console.log(client)`, `util.inspect` and `JSON.stringify` never show it, and it scrubs
the base URL's userinfo (raw and percent-decoded) from error bodies and details,
transport error text (fetch's "Request cannot be constructed from a URL that includes
credentials: …") and the `cause` chain it attaches.

## API-specific details (read this before "aligning" with the blueprint)

FragDenStaat is **not** shaped like the other repos' APIs. The provided OpenAPI
schema (`fragdenstaat.de.yaml`, drf-spectacular) does **not** match what the server
actually serves; everything below was verified empirically against the live API.
When in doubt, trust the live API, not the schema.

- **Wire format is Tastypie, not DRF.** List responses are a `{ meta, objects }`
  envelope — `meta = { limit, offset, total_count, next, previous }`, `objects` is
  the array. Detail responses are the bare object. This is typed as `TastypieList<T>`
  in `types.ts`, **not** the `{ count, next, previous, results }` the schema claims.
  `getJson` checks that envelope on every JSON answer (`responseShapeProblem`): a
  list, search or autocomplete call must get an object with an `objects` array and a
  `meta` object holding a numeric `total_count`, a `get` a non-empty object. Anything
  else — `null`, `{}`, `{"detail": "Wartung"}`, an array — is an `FdsParseError`
  (`Unexpected response from <path> (HTTP 200): …`, exit 1), never printed as data or
  read as "nothing found". The records themselves are not schema-validated.
- **Related resources are hyperlinked** as absolute `resource_uri` URLs, not embedded
  (a request's `public_body` is a nested exception; detail responses inline
  `law`/`public_body`/`messages`). List items are typed for the common scalar fields;
  nested/free-form sub-objects and all detail responses are `JsonValue`/`JsonObject`.
- **`limit` is hard-capped at 50** by the server (anything larger, and `limit=0`, is
  silently clamped). The library rejects a `limit` outside `1..MAX_PAGE_SIZE` (50) and
  an `offset` that is not a non-negative integer (see
  [Input validation](#input-validation)); the CLI's `--limit`/`--offset`
  (`addPagination`) use the same rules, and users page with `--offset`. Search
  endpoints additionally cap `total_count` at 10000.
- **Trailing slashes are mandatory** — a slashless path 301-redirects (Django
  `APPEND_SLASH`). Every client path ends in `/`, and the engine does **not** follow
  redirects (a 3xx surfaces as an `FdsApiError` whose message names the target:
  `redirect to <Location> not followed`, the Location resolved, redacted and
  sanitised), so this matters. `http://` likewise 301s to `https://`.
- **A plain-`http:` base URL warns.** To a host other than loopback (`localhost`,
  `127.0.0.0/8`, `::1`) the CLI writes one `WARN` record of `fragdenstaat.http` on stderr per run,
  before the first request (`action()` in `shared.ts`); the sentence comes from the exported
  `cleartextProblem(baseUrl, secrets?)`, names the host and, for a `user:password@`, "the base
  URL's credentials" (never the value). Help, version and usage errors never warn; stdout
  and the exit code are untouched.
- **`--base-url` is validated at parse time** (`parseBaseUrl` in `shared.ts`) with
  the library's `baseUrlProblem`, so a commander usage error names the value the user
  passed: only `http:`/`https:`, no query or fragment, no whitespace or control
  characters, matching the sibling repos' blueprint. Library callers who bypass the CLI
  get the same rules from the `RequestEngine` constructor (`validateBaseUrl`, an
  `FdsValidationError`; see [Input validation](#input-validation)), so a custom
  transport never receives a `file:` or `ftp:` URL. The default transport (`http.ts`)
  still re-checks the scheme of every fully-built request URL as a backstop, and that
  per-hop check is an `FdsNetworkError`.
- **Points are validated** by the library (`pointProblem`, see
  [Input validation](#input-validation)): georegion `latlng` and publicbody `lnglat`
  (`--latlng`/`--lnglat`, whose `parsePoint` uses the same rule) must be two
  comma-separated decimals within ±90/±180 in the parameter's order. The API silently
  ignores an unparseable point (no 400) and returns the whole table.
- **`get <id>` takes digits only** (every wrapped detail endpoint has an integer id in
  the OpenAPI description). The library's `get()` enforces it (`resourceIdProblem`, see
  [Input validation](#input-validation)) and the CLI's `parseId` uses the same rule. As
  a backstop the engine's `buildUrl` still rejects a `.`/`..` path segment, which URL
  parsing would otherwise resolve to the list or the API root.
- **`-o/--output` never silently overwrites.** The write opens exclusively (`wx`), so
  an existing file is refused with a clear "refusing to overwrite … (use --force)"
  error; pass `--force` to overwrite deliberately. This holds for both the JSON and
  `--csv` output paths. Applied via `writeOutput` in `shared.ts`; the `CliIO.writeFile`
  seam takes an `exclusive` flag so tests can drive both branches. `-o -` (and
  `--output=-`) means stdout, exactly like no `-o` (`outputFile` in `shared.ts`); it
  used to write a file literally named `-`.
- **CSV is a first-class server feature.** `?format=csv` (with `Accept: text/csv`)
  returns a flattened CSV (nested objects become dotted columns). Exposed as `--csv`
  on `list`/`search` commands via `client.<resource>.listCsv()` (`getRaw`). Note:
  `?format=csv` combined with an `Accept: application/json` header 406s, so the CSV
  path negotiates `Accept: text/csv` explicitly. A CSV response is **one page**
  (`limit` capped at 50, like JSON) and carries no `total_count`/`next`, so
  `renderCsvPage` (`shared.ts`) counts the data rows (quote-aware) and prints a
  stderr note when the page came back full. `getRaw` refuses a 2xx HTML page (by
  Content-Type, or a body that starts `<!doctype html`/`<html`) or a JSON body
  answered to a CSV request with an `FdsParseError`, so `-o` never saves a maintenance
  page as `requests.csv`. `format=xml` 404s everywhere;
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
- **No published rate limit** and **no `Retry-After`** header seen so far. The engine
  still retries transient `429`/`503` (defensive). Each retry waits
  `retryDelayMs * attempt` (200/400 ms by default; `retryDelayMs` 0..30 000), or the
  response's `Retry-After` (delay-seconds or an IMF-fixdate, `parseRetryAfter`) when
  that is longer: the header can lengthen a wait, never shorten it, so `Retry-After: 0`
  or a past date doesn't turn the retries into a burst. A `Retry-After` above
  `MAX_RETRY_AFTER_MS` (30 s) is not retried at all: the `FdsApiError` surfaces at once,
  with `retryAfterMs` set and a message that names the wait (`…; the server asked to
  retry after 3600 s, longer than the 30 s the client waits; not retried — try again
  after that`). After spent retries the message ends `(after N retries)` and `retries`
  holds the count. A connection reset (`ECONNRESET`, `EPIPE`, `ECONNABORTED`,
  undici's `UND_ERR_SOCKET`, anywhere in the error's `cause` chain, from any transport)
  is retried the same way, with the linear backoff; a timeout, a refused connection or
  a DNS failure is not. `maxRetries` is capped at `MAX_RETRIES` (10). It sends a
  descriptive `User-Agent` (`fragdenstaat-cli`). Be a good citizen when paging.
- **Filter-name quirks** (verified live): `request list` uses **plural**
  `--categories` and `--public-body`; `publicbody list` uses **singular** `--category`
  (the API silently ignores a plural `categories` there, and the CLI rejects
  `--categories` as an unknown option) — but `publicbody search` is the other way
  round: its endpoint only reads plural `categories` and ignores `category`, so the
  CLI maps the same `--category` flag to `categories` there
  (`buildPublicBodySearchParams`; the library's `PublicBodySearchParams` has
  `categories`). The search endpoint has no `classification_id`, `slug` or `lnglat`
  (Froide's `PublicBodyAPIFilterSet`; `lnglat` was checked live: 1817 hits with and
  without it), so `PublicBodySearchParams` no longer has them. Its working classification
  filter is `classification` (an id; `publicbody search --classification`), checked live on
  2026-10-06: `classification=118` (Ministerium) narrowed the 10000 hits to 225, every one
  shown a Ministerium, while `classification_id=118` was ignored (10000 again). The list
  endpoint's exact `classification_id=118` matched 207, so search's filter is at least as
  wide as the exact one — consistent with a subtree match like list's `--classification`. `publicbody list`
  distinguishes `--classification` (subtree) from `--classification-id` (exact).
  `--regions` with one id matches that region and its sub-regions; a comma list matches
  exactly those regions; a single id that doesn't exist filters nothing upstream (every
  public body comes back), and an unknown id in a list silently matches nothing. So
  `publicBodies.list`/`listCsv`/`search`/`searchCsv` look each `regions` id up first
  (`GET /api/v1/georegion/<id>/`, sequentially; the detail includes the geometry, so a
  Land costs a larger download) and reject an id answered with 404 as an
  `FdsValidationError` naming it, before the list request (CLI: exit 1); any other lookup
  failure propagates. The 404 for an unknown georegion was checked live (2026-10-06). `document --tag` takes a tag **slug**
  (`to_field_name="slug"` in django-filingcabinet: `--tag lobbyismus` found 53
  documents, `--tag 1` none), and `request --tags` one tag **name**, exact and
  case-sensitive. Request `--categories` and `--classification` match the exact
  category/classification **name** (`public_body__categories__name`; `Umwelt` found
  4289 requests, `9`/`umwelt` none).

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
`parity.test.ts` sends one input through the CLI and through the library (`parity()` in
`helpers.ts`) and asserts the same outcome; `validate.test.ts` covers the rules and
`filters.test.ts` the per-endpoint parameter tables. `log.test.ts` tests the record helpers
of `src/cli/log.ts` on their own (`escapeForRecord`, `formatLogRecord`); the CLI-level
checks are P23's.

The `conformance-p*.test.ts` files are shared across the `*-cli` repos (fix plan
`.reviews/2026-10-05-exploratory/`; only their adapter block at the top is
repo-specific): P1 CLI output redaction, P2 library redaction, P4/P19 configuration
validation (P19 skipped: this CLI reads no environment variable), P5 the transport
contract, P6 the retry policy, P7 pipes and exit codes (runs the built bin), P8/P9/P13
charset, 2xx body shape and error classes, P10 strict filters, P12 `-o -`, and from the
follow-up round 2026-10-06 P20 the stderr warning for a plain-`http:` base URL (environment and
API-key cases skipped: no variable, no key) and P21 README links (a relative link must point at
a file `files` ships, since npmjs.com shows the README; anything else is an absolute GitHub URL),
and P23 the log on stderr (records with timestamp, level and topic; `--log-format text|jsonl`).
Tests must keep passing on Node 22/24 (`engines`: `>=22.12`, the floor of the pinned commander 15).

## CI / release

`.github/workflows/`: `ci.yml` (typecheck + build + test on Node 22/24),
`release.yml` (on a `v*` tag: test, `npm pack`, CycloneDX SBOMs, GitHub Release),
`publish.yml` (manual npm publish via OIDC trusted publishing, dispatched from the release tag: `gh workflow run publish.yml --ref vX.Y.Z`), `docs.yml` (website + TypeDoc
→ GitHub Pages, via the isolated `tools/docs/` toolchain). The npm tarball ships only `dist/src` + `LICENSING.md` +
`CONTRIBUTING.md` (see `package.json` `files` and `.npmignore`); `skills/`,
`.claude-plugin/`, tests and the spec are excluded.

## Website

The project website — <https://maschinenlesbar-org.github.io/fragdenstaat-cli/> in English and
<https://maschinenlesbar-org.github.io/fragdenstaat-cli/de/> in German — is built from `site/`
with [Jekyll](https://jekyllrb.com/), [banira](https://sebs.github.io/banira/) web components
and [Fylgja](https://fylgja.dev/) CSS, and deployed by `docs.yml` together with the TypeDoc API
reference under `/api/`. Its content comes from this repository: the README intro and quick
start, the command tree of the built CLI (`site/scripts/cli-reference.mjs`), `Usage.md`,
`GLOSSARY.md` and its German version `GLOSSARY.de.md`, the skills, and the skill examples in
`EXAMPLE.md` and `EXAMPLE.de.md`. The only repo-specific files are `site/_config.yml` and
`site/_data/project.yml` (the German intro and the access requirements); the rest of `site/` is
identical in every maschinenlesbar.org CLI, so change it in all of them together. When the
README intro changes, update the German intro in `site/_data/project.yml`.

```bash
npm run build                        # the CLI, for the command reference
cd site && npm ci && bundle install  # once (Node >= 22.12, Ruby 3.4, Bundler)
npm run serve                        # http://127.0.0.1:4000/fragdenstaat-cli/
```

## The log on stderr

Every diagnostic line on stderr is a log record (`src/cli/log.ts`): a timestamp, a level
(`ERROR`, `WARN`, `INFO`) and a topic, `fragdenstaat.<area>`. `--log-format text` (the
default) writes it log4j style, `<ISO 8601 UTC> <LEVEL padded to 5> [<topic>] <message>`;
`--log-format jsonl` writes one JSON object per line with exactly `ts`, `level`, `topic`
and `msg`. A record is always one line: `formatLogRecord` runs `escapeForRecord` over
the message (text) or the whole JSON object (jsonl), which writes CR and LF as `\r`/`\n`,
every other C0 control but TAB, DEL and C1 as `\u00XX`, and U+2028, U+2029 and the bidi
controls as `\uXXXX`, so no text that reaches a record, by whatever path (a server's text,
a value the user typed, an `-o` path), can split it, forge another one or steer the
terminal. Before that a lone surrogate (half a character, which jq rejects, stopping the
whole stream) becomes U+FFFD (`toWellFormed`), and a message longer than
`MAX_RECORD_MESSAGE` (4000 characters, exported) is cut at a code point and ends in
`… (N more characters)`. The areas are `cli` (usage errors, commander's messages and the help it shows
after one, unexpected errors), `api` (the API's answers, the notes on an empty name-filtered
`request list` and on a full CSV page), `http` (the connection, the cleartext warning) and
`output` (`Wrote N bytes to …`). Code logs through `logOf(deps)` and never writes
diagnostics with `io.err` directly. `run()` builds the logger from argv before commander
parses it, so commander's own usage errors are records too, and on top of the redacted
`io.err`, so a secret is kept out of the log in either format. `CliDeps.now` makes the
timestamps testable. stdout carries data only. The one line that is not a record is
`Output error: …`, which `handleOutputErrors` writes straight to `process.stderr` when
stdout itself fails, outside any run. Conformance test P23 checks all of this, and its
body is shared across the *-cli repos.
