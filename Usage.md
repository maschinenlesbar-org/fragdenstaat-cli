# Usage

Full command reference for `fragdenstaat`. Run `fragdenstaat <group> <sub> --help`
for the authoritative, always-current flag list. Global options
(`--base-url`, `--timeout`, `--user-agent`, `--max-retries`, `--max-response-bytes`,
`--compact`, `-o/--output`, `--force`) work on every command. `-o` never overwrites an
existing file (`refusing to overwrite existing file … (use --force)`, exit 1); add
`--force` to overwrite it.

Conventions: `list`/`search` (and `autocomplete`/`request tags`) accept `--offset <n>`
and `--limit <1..50>`; where the
server supports it they also accept `--csv` (streams the flattened CSV export of
that one page — at most 50 rows, no `total_count`; a full page prints a stderr note).
Each filter and paging option takes one value: giving it twice is a usage error
(only `document list --ids` accumulates repeats into one comma-separated list).
IDs are numeric — resolve names via `autocomplete`/`list --q` first
(`category autocomplete` returns names only; use `category list --q` for category ids).

## request — FOI requests

```bash
fragdenstaat request list [filters]
fragdenstaat request get <id>
fragdenstaat request search --q "<text>" [--jurisdiction <slug>] [--category <slug>]
fragdenstaat request tags <query>        # autocomplete tag names
```

`request list` filters:

| Flag | Meaning |
|---|---|
| `--status <s>` | lifecycle status (see GLOSSARY) |
| `--resolution <r>` | outcome — only meaningful with `--status resolved` |
| `--jurisdiction <id>` · `--law <id>` | by jurisdiction / FOI law id |
| `--categories <id>` | topic category id (**plural** flag) |
| `--classification <id>` | public-body classification id |
| `--campaign <id>` · `--public-body <id>` | by campaign / addressed body id |
| `--tags <tag>` | tag **name** (e.g. `lobbyismus`) |
| `--reference <prefix>` · `--slug <slug>` | by reference prefix / exact slug |
| `--is-foi [bool]` · `--checked [bool]` · `--has-same [bool]` | boolean filters |
| `--costs-min <eur>` · `--costs-max <eur>` | charged-cost range |
| `--created-after <YYYY-MM-DD>` · `--created-before <YYYY-MM-DD>` | date range |
| `--project <id>` · `--user <id>` · `--follower <id>` | by project / user / follower |

`--status`: `awaiting_user_confirmation`, `publicbody_needed`,
`awaiting_publicbody_confirmation`, `awaiting_response`, `awaiting_classification`,
`asleep`, `resolved`. `--resolution`: `successful`, `partially_successful`,
`not_held`, `refused`, `user_withdrew`, `user_withdrew_costs`.

## publicbody — authorities (Behörden)

```bash
fragdenstaat publicbody list [--q <text>] [--jurisdiction <id>] [--classification <id>] \
    [--classification-id <id>] [--category <id>] [--regions <id>] [--slug <slug>] [--lnglat <lng,lat>]
fragdenstaat publicbody get <id>
fragdenstaat publicbody search --q "<text>" [--jurisdiction <id>] [--classification <id>] [--category <id>]
fragdenstaat publicbody autocomplete <query>
```

Note: **singular** `--category` here (`--categories` is rejected as an unknown option).
On `search` the CLI sends it as the API's `categories` parameter, the only name the
search endpoint reads.
`--classification` matches a subtree; `--classification-id` is exact. `--lnglat` is
`lng,lat` (longitude first) and keeps only bodies whose `regions` contain that point, in
name order rather than by distance, and a body appears once per region that contains
the point (Stadt Leipzig twice for a Leipzig point).

## law — FOI laws

```bash
fragdenstaat law list [--q <text>] [--jurisdiction <id>] [--mediator <id>] [--meta [bool]] [--id <id>]
fragdenstaat law get <id>
fragdenstaat law autocomplete <query>
```

`--meta` selects meta-laws (combinations). `get` includes `legal_text`,
`max_response_time`(+unit) and `requires_signature`.

## jurisdiction / campaign — list + get

```bash
fragdenstaat jurisdiction list        # Bund + 16 Länder + EU (18)
fragdenstaat jurisdiction get <id>
fragdenstaat campaign list            # ~18 campaigns (no filters)
fragdenstaat campaign get <id>
```

## category / classification — taxonomy trees

```bash
fragdenstaat category list [--q <text>] [--name <name>] [--parent <id>] [--ancestor <id>] [--depth <n>] [--is-topic [bool]]
fragdenstaat category get <id>
fragdenstaat category autocomplete <query>

fragdenstaat classification list [--q <text>] [--name <name>] [--parent <id>] [--ancestor <id>] [--depth <n>]
fragdenstaat classification get <id>
```

`--parent` = direct children; `--ancestor` = all descendants.

## georegion — geographic regions

```bash
fragdenstaat georegion list [--q <text>] [--name <name>] [--kind <k>] [--kind-detail <text>] \
    [--level <n>] [--region-identifier <id>] [--slug <slug>] [--ancestor <id>] [--id <id>] [--latlng <lat,lng>]
fragdenstaat georegion get <id>       # includes geometry (can be large)
fragdenstaat georegion autocomplete <query>
```

`--kind`: `country`, `state`, `admin_district`, `district`, `admin_cooperation`,
`municipality`, `borough`, `zipcode`, `admin_court_jurisdiction`. `--latlng` is
`lat,lng` (point-in-region lookup), two decimal numbers with no space
(`51.34,12.37`). The API ignores a point it cannot parse and returns every region, so
the CLI rejects a malformed or out-of-range point (latitude beyond ±90, longitude
beyond ±180) as a usage error; the same check applies to `publicbody --lnglat`.

## message — correspondence

```bash
fragdenstaat message list [--request <id>] [--kind <k>] [--is-response [bool]]
fragdenstaat message get <id>
```

`--kind`: `email`, `post`, `fax`, `upload`, `phone`, `visit`, `import`. Scope to one
request with `--request <id>`.

## document — published documents

```bash
fragdenstaat document list [--publicbody <id>] [--foirequest <id>] [--collection <id>] \
    [--portal <id>] [--directory <id>] [--tag <id>] [--ids <id,id,…>] \
    [--created-after <YYYY-MM-DD>] [--created-before <YYYY-MM-DD>]
fragdenstaat document get <id>        # includes pages[]
```

`--tag` needs a **numeric** tag id. `--ids` is a comma-separated document-id list.

## Examples

```bash
# Success rate of resolved requests to the federal government
fragdenstaat --compact request list --jurisdiction 1 --status resolved --resolution successful --limit 1 \
  | grep -o '"total_count":[0-9]*'

# Grundschule public bodies in a jurisdiction, to CSV (one page of up to 50 rows;
# a full page prints a stderr note, fetch the next one with --offset 50)
fragdenstaat classification list --q "Grundschule"
fragdenstaat publicbody list --classification 642 --jurisdiction 14 --csv -o schools.csv

# Full message thread of a request
fragdenstaat request get 34126 | jq '.messages[] | {kind, is_response, subject}'
```
