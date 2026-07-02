# fragdenstaat-cli

A command-line client and TypeScript library for the public, read-only API of
**[FragDenStaat.de](https://fragdenstaat.de)** — Germany's central Freedom-of-Information
(*Informationsfreiheit*) portal, run by the Open Knowledge Foundation Deutschland.

Query ~285,000 FOI requests, ~42,000 public bodies, the ~189 German FOI laws, and
the published documents behind them — from your shell or from Node. No API key, no
account, no config: the data is public and read-only.

- **Zero-key.** Every wrapped endpoint is anonymously readable.
- **Zero runtime HTTP deps.** Built on `node:http`/`https`; the only runtime
  dependency is `commander`.
- **JSON or CSV.** Pretty/compact JSON by default; `--csv` streams the server's
  flattened CSV export for spreadsheets/pandas.
- **Library + CLI.** Import the typed `FragDenStaatClient`, or run `fragdenstaat`.

> **This is a client, not the data.** It only accesses data served live by
> FragDenStaat. See [DATA_LICENSE.md](DATA_LICENSE.md) — the corpus is a mix of
> public-domain authority responses, CC0 user contributions, and personal data.

## Install

```bash
npm install -g @maschinenlesbar.org/fragdenstaat-cli
# or run once, without installing:
npx @maschinenlesbar.org/fragdenstaat-cli --help
```

Requires Node ≥ 20.

## Quick start

```bash
# Find FOI requests about a topic (full-text search)
fragdenstaat request search --q "Videoüberwachung" --limit 5

# Filter requests: resolved & successful, federal jurisdiction
fragdenstaat request list --status resolved --resolution successful --jurisdiction 1 --limit 10

# One request in full, including its message thread
fragdenstaat request get 374948

# Which authority handles a topic? (name -> id, then profile)
fragdenstaat publicbody autocomplete "Umweltbundesamt"
fragdenstaat publicbody get 1

# Which FOI law applies in a jurisdiction?
fragdenstaat jurisdiction list
fragdenstaat law list --jurisdiction 1 --q umwelt

# Export a dataset to CSV
fragdenstaat request list --status resolved --jurisdiction 1 --csv -o requests.csv
```

Output is the Tastypie envelope:

```json
{
  "meta": { "limit": 5, "offset": 0, "total_count": 199646, "next": "…", "previous": null },
  "objects": [ { "id": 1, "title": "…", "status": "resolved", "resolution": "successful", … } ]
}
```

## Commands

| Group | Sub-commands | Notes |
|---|---|---|
| `request` | `list` · `get <id>` · `search` · `tags <query>` | FOI requests — the core resource |
| `publicbody` | `list` · `get <id>` · `search` · `autocomplete <query>` | Authorities (Behörden) |
| `law` | `list` · `get <id>` · `autocomplete <query>` | FOI laws (IFG/UIG/VIG + state/local) |
| `jurisdiction` | `list` · `get <id>` | Bund + 16 Länder + EU |
| `category` | `list` · `get <id>` · `autocomplete <query>` | Topic taxonomy (tree) |
| `classification` | `list` · `get <id>` | Public-body types (tree) |
| `campaign` | `list` · `get <id>` | Coordinated mass-request projects |
| `georegion` | `list` · `get <id>` · `autocomplete <query>` | Regions (state/district/zip…) |
| `message` | `list` · `get <id>` | Correspondence within requests |
| `document` | `list` · `get <id>` | Published documents from responses |

`list`/`search` take `--offset`/`--limit` and (where the server supports it) `--csv`.
Run `fragdenstaat <group> <sub> --help` for the full filter set, or see
[Usage.md](Usage.md).

### Global options

| Flag | Purpose |
|---|---|
| `--base-url <url>` | override the API base (default `https://fragdenstaat.de`) |
| `--timeout <ms>` | per-request timeout |
| `--user-agent <ua>` | override the `User-Agent` |
| `--max-retries <n>` | retries for transient 429/503 |
| `--max-response-bytes <n>` | cap the response body size (0 = unlimited) |
| `--compact` | single-line JSON |
| `-o, --output <file>` | write JSON (or CSV with `--csv`) to a file instead of stdout |

### Good to know

- **Page size is capped at 50** by the server. `--limit` accepts `1..50`; page with
  `--offset`. `meta.total_count` is the real total (search endpoints cap it at 10000).
- **IDs are numeric.** Resolve a name to its id first via `autocomplete` or
  `list --q`, then filter by id.
- **Anonymous = public only.** `resolution` is empty until a request is `resolved`.
- **Exit codes:** `0` success; `4` for a 404 (not found); `1` for any other API or
  runtime error. Errors print to stderr; stdout stays clean for piping.

## Library usage

```ts
import { FragDenStaatClient } from "@maschinenlesbar.org/fragdenstaat-cli";

const fds = new FragDenStaatClient();

const { meta, objects } = await fds.requests.list({
  status: "resolved",
  resolution: "successful",
  jurisdiction: 1,
  limit: 50,
});
console.log(meta.total_count, objects[0]?.title);

const law = await fds.laws.get(124);
```

Every resource group exposes `.list(params)` and `.get(id)`; `request`/`publicbody`
add `.search()`, and `request`/`publicbody`/`law`/`category`/`georegion` add
autocomplete. Errors are typed (`FdsApiError` with `.status`/`.detail`,
`FdsNetworkError`, `FdsParseError`). The full API docs build with `npm run docs`.

## Skills

This repo ships four [Claude Code Agent Skills](SKILLS.md) (packaged as a plugin
marketplace) that drive the CLI for common tasks: finding & analysing requests,
looking up authorities, exploring the FOI legal landscape, and digging out /
exporting documents.

## Licensing

Code is dual-licensed **AGPL-3.0-or-later OR commercial** — see
[LICENSING.md](LICENSING.md). No external code contributions are accepted
([CONTRIBUTING.md](CONTRIBUTING.md)); bug reports and AGPL forks are welcome. The
*data* is governed separately by the provider — see [DATA_LICENSE.md](DATA_LICENSE.md).
