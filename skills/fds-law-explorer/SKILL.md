---
name: fds-law-explorer
description: >
  Explain the German FOI legal landscape as modelled by FragDenStaat — which law
  applies in a given jurisdiction, the three federal pillars (IFG, UIG, VIG), state
  Transparenzgesetze and local Satzungen, statutory response deadlines, and whether
  a request needs a signature. Trigger when the user asks "what FOI law applies in
  Sachsen?", "which laws cover environmental information?", "response deadline under
  the IFG", "list transparency acts by state", "does Bayern have a Transparenzgesetz?",
  "what's the difference between IFG, UIG and VIG?", or "which law should I use to
  request environmental data in Hessen?". Resolves a jurisdiction name to its id,
  filters the ~189 laws, and always reports the deadline with its unit.
version: 1.0.0
userInvocable: true
---

# FDS Law Explorer

Help the user understand **which German FOI law applies and on what terms** — the
governing statute for a jurisdiction or topic, its statutory response deadline (with
the correct unit), and whether filing needs a signature. FragDenStaat models ~189
laws, from the federal pillars down to a single district's Informationsfreiheitssatzung.

## Tooling

This skill drives the `fragdenstaat` command. **Before anything else, validate it is available** — run `command -v fragdenstaat` (or `fragdenstaat --version`). If it is not on your PATH, STOP and inform the user that the `fragdenstaat` CLI (`@maschinenlesbar.org/fragdenstaat-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

The API is read-only and needs **no key, account, or config**. Pass `--compact` for machine-readable JSON. Responses are Tastypie envelopes: `{"meta":{"total_count":N,"limit":L,"offset":O,"next":...,"previous":...},"objects":[...]}`; autocomplete objects are `{"value":...,"label":...}`. `--limit` is capped at **50** by the server — page with `--offset`. Anonymous access returns only **public** objects. An empty result is `{"meta":{"total_count":0,...},"objects":[]}` and exits `0` — a valid "nothing matched" answer.

## The legal landscape (teach this)

Three **federal pillars**, each covering a different kind of information:

| Law | Full name | Covers |
|---|---|---|
| **IFG** | Informationsfreiheitsgesetz | general access to federal records/records held by federal bodies |
| **UIG** | Umweltinformationsgesetz | environmental information (states have their own, e.g. HUIG for Hessen) |
| **VIG** | Verbraucherinformationsgesetz | consumer / food-safety information |

Each of the **16 Länder** has its own IFG *or* a broader **Transparenzgesetz** (e.g.
Hamburg, Rheinland-Pfalz), and some districts add a local
**Informationsfreiheitssatzung**. A **"meta law"** (`meta: true`) bundles several
laws a requester can invoke together in one request; most concrete statutes are
**non-meta**.

## Step 1 — Resolve the jurisdiction to an id

Jurisdiction / law ids are **numeric**. Map a jurisdiction *name* to its id before
filtering laws by it:

```bash
fragdenstaat --compact jurisdiction list
fragdenstaat --compact jurisdiction get 3
```

`jurisdiction list` returns the 18 jurisdictions (Bund, the 16 Länder, the EU) with
their `id`, `name`, and `slug`. Read the id you need from there.

## Step 2 — Find the applicable law(s)

Filter the law catalogue by jurisdiction and/or topic:

```bash
# every law for one jurisdiction (use the id from step 1)
fragdenstaat --compact law list --jurisdiction 3 --limit 50

# environmental-info laws across all jurisdictions
fragdenstaat --compact law list --q umwelt --limit 50

# only the combining meta-laws
fragdenstaat --compact law list --meta true --limit 50

# pin a law by name
fragdenstaat --compact law autocomplete "Umweltinformationsgesetz"
```

`law list` fields worth tabling:

| Field | Meaning |
|---|---|
| `id` | numeric law id — what you filter/`get` by |
| `name` | e.g. "Informationsfreiheitsgesetz", "Hamburgisches Transparenzgesetz" |
| `law_type` | Gesetz / Satzung / Verordnung etc. |
| `jurisdiction` | the owning jurisdiction (id/name) |
| `meta` | `true` for combining meta-laws; `false` for a concrete statute |
| `max_response_time` | numeric deadline, **paired with its unit** |
| `max_response_time_unit` | e.g. `month_de` (calendar month), `working_day`, `day` — **the unit is load-bearing** |
| `requires_signature` | whether filing needs a handwritten signature |
| `mediator` | the mediator/appeals public-body id, if any |
| `priority` | ordering hint when several laws apply |
| `slug` / `site_url` | canonical slug and the page on fragdenstaat.de |

## Step 3 — Read one law in full

```bash
fragdenstaat --compact law get 1
```

A `law get` adds the full text and boilerplate: `legal_text` (the statute text),
`letter_start` / `letter_end` (request-letter boilerplate), `max_response_time`
(+unit), `requires_signature`, `refusal_reasons`, and — for a **meta law** —
`combined[]` (the ids/names of the laws it bundles).

> **Traps.**
> - **Resolve the jurisdiction NAME to its id first** (`jurisdiction list`) before
>   `law list --jurisdiction <id>` — the filter takes the numeric id, not "Sachsen".
> - `--meta true` selects the combining meta-laws; **most concrete statutes are
>   non-meta**, so don't answer "which law applies" from meta-only results. Use
>   `--meta false` (or no `--meta`) for the real statute.
> - **`legal_text` can be very large.** Summarise it; only dump the full text on
>   request, and write it out with `-o law.txt` rather than flooding the chat.
> - **Always state the response-time unit.** "1" means nothing without knowing it's
>   `month_de` (a calendar month) vs `working_day` — the semantics differ. Report
>   `max_response_time` and `max_response_time_unit` together, in plain words.
> - `--limit` is capped at **50** by the server; page with `--offset` for the full
>   ~189-law catalogue.
> - Anonymous access is public-only; `meta.total_count` is the true count of matches.

## Worked example — "which law for environmental data in Hessen?"

```bash
# 1. jurisdiction name -> id
fragdenstaat --compact jurisdiction list         # find "Hessen", read its id (say 6)

# 2. that jurisdiction's environmental-info law
fragdenstaat --compact law list --jurisdiction 6 --q umwelt --limit 50

# 3. read its deadline + signature rule
fragdenstaat --compact law get <hessen-uig-id>
```

Then present the UIG-equivalent (here the **HUIG**, Hessisches
Umweltinformationsgesetz): its `name`, the statutory deadline **with its unit**
(e.g. "one month, `month_de`"), whether `requires_signature` is set, and the
`site_url` for the full statute. If the user's data spans several bodies, mention
whether a `meta` law lets them invoke multiple statutes in one request.
