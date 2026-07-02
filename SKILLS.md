# fragdenstaat-cli — Claude Code Skills

A set of [Claude Code](https://code.claude.com/docs/en/skills) **Agent Skills** for
**FragDenStaat.de** — Germany's Freedom-of-Information portal — all powered by the
**[fragdenstaat](README.md)** CLI over the public, read-only FragDenStaat API
(`fragdenstaat.de`): FOI requests, public bodies, the German FOI laws, and the
documents released through them.

Each skill teaches Claude how to drive the `fragdenstaat` CLI to answer a specific,
real-world question — "how did FOI requests about surveillance cameras go?", "which
authority handles environmental data in Hamburg?", "what FOI law applies in Sachsen?",
"export the documents from this authority" — and to report the answer with evidence
rather than guesswork. They encode the parts that are easy to get wrong (the 50-row
page cap, resolving names to numeric ids, the singular-vs-plural `category`/`categories`
filters, resolution being empty until a request is resolved) so Claude doesn't
rediscover them each time.

## Skills

| Skill | What it does | Ask it… |
|---|---|---|
| **fds-request-finder** | Finds and analyses FOI requests — full-text search + faceted filtering by status/resolution/jurisdiction/law/body/tags/dates/costs — and interprets outcomes. | "how did requests about video surveillance go?", "successful IFG requests to the Umweltbundesamt", "refused requests in Bayern" |
| **fds-authority-lookup** | Finds the right public body to address a request to and profiles it (FOI contact, type, jurisdiction, request history), incl. proximity search. | "who handles building permits in Munich?", "FOI email for the Umweltbundesamt", "how many requests has this ministry answered?" |
| **fds-law-explorer** | Explains the German FOI legal landscape: which law applies where, IFG/UIG/VIG, state Transparenzgesetze, response deadlines, signature requirements. | "what FOI law applies in Sachsen?", "response deadline under the IFG", "list transparency acts by state" |
| **fds-document-digger** | Locates published FOI documents (scoped by authority/request/collection/portal) and exports request or document datasets to CSV. | "documents from the Umweltbundesamt", "export FOI requests about lobbying to CSV", "documents from request 12345" |

## Requirements

- **[Claude Code](https://code.claude.com/docs/en/overview)** (or any harness that
  loads Agent Skills).
- **The `fragdenstaat` CLI** installed globally:
  ```bash
  npm i -g @maschinenlesbar.org/fragdenstaat-cli   # installs the `fragdenstaat` bin
  ```
  Verify with `command -v fragdenstaat` or `fragdenstaat --version` before running any
  skill. **No API key is required** — the API is free, read-only, and needs no account
  or configuration.

## Installation

### Plugin marketplace (recommended)

This repo is a Claude Code **plugin marketplace**, so installation is two commands
inside Claude Code:

```
/plugin marketplace add maschinenlesbar-org/fragdenstaat-cli
/plugin install fragdenstaat@fragdenstaat-skills
```

The first command registers the marketplace; the second installs the `fragdenstaat`
plugin, which bundles all four skills. Update later with `/plugin marketplace update`.

### Manual (copy the skill folders)

Prefer not to use the marketplace? Copy the skills into your **personal** directory
(available across all your projects):

```bash
git clone https://github.com/maschinenlesbar-org/fragdenstaat-cli tmp-skills
mkdir -p ~/.claude/skills
cp -R tmp-skills/skills/* ~/.claude/skills/
rm -rf tmp-skills
```

…or into a single project's `.claude/skills/` by swapping `~/.claude/skills` for
`.claude/skills`. Each skill lives in its own directory with a `SKILL.md`, e.g.
`skills/fds-request-finder/SKILL.md`. Start a new Claude Code session and the skills
are picked up automatically.

## Usage

You don't normally invoke these by name — Claude auto-selects the right skill from
your request. Just ask in natural language:

> How did FOI requests about video surveillance turn out — how many succeeded?

> Which authority do I ask about environmental data in Hamburg, and what's their FOI
> contact?

> What Freedom-of-Information law applies in Sachsen, and what's the response deadline?

> Export every document published by the Umweltbundesamt to a CSV.

You can also invoke a skill explicitly with its slash command, e.g.
`/fds-request-finder`.

## How it works

Every skill is a single `SKILL.md` — a short, model-facing playbook describing which
`fragdenstaat` subcommands to call, in what order, and how to interpret the JSON. The
skills encode the non-obvious parts of this API, for example:

- responses are a **Tastypie `{ meta, objects }` envelope** and `--limit` is
  **hard-capped at 50** — page with `--offset`, and read `meta.total_count` for the
  real total (search endpoints cap it at 10000);
- **IDs are numeric** — a jurisdiction/law/category/classification/public-body name
  must be resolved to its id via `autocomplete` or `list --q` before filtering;
- **`request list` uses plural `--categories` and `--public-body`**, while
  **`publicbody list` uses singular `--category`** (plural is ignored) and
  distinguishes `--classification` (subtree) from `--classification-id` (exact);
- **`resolution` is empty until `status = resolved`** — filter by `--status resolved`
  before judging an outcome; only *public* objects are visible anonymously;
- **`document --tag` needs a numeric tag id**, whereas **`request --tags` takes a tag
  name** — a mismatch 400s;
- **`--csv`** streams the server's flattened export (dotted column names) for
  datasets past the 50-row JSON cap; file-writing skills confirm the `-o` path and
  report the row/byte count they wrote;
- an empty match is `{"meta":{"total_count":0,…},"objects":[]}` and exits `0` — a
  valid answer, not an error; a missing id exits `4`.

## Contributing

This project does not accept external code contributions (see
[CONTRIBUTING.md](CONTRIBUTING.md)). When adding a skill internally, keep `SKILL.md`
focused, give it a `description` with concrete trigger phrases, and follow the
[official skill format](https://code.claude.com/docs/en/skills).

## License

[AGPL-3.0-or-later](LICENSE) © Sebastian Schürmann. See [LICENSING.md](LICENSING.md)
for the dual-licensing / commercial option.
