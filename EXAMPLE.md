# Examples

Real examples for the Claude Code skills of the `fragdenstaat` plugin, one per skill: a request,
the `fragdenstaat` commands the skill ran, and the answer Claude gave.

Every example ran against the live API on 15 September 2026 with `fragdenstaat` 0.0.7.
The data changes, so your results will differ; the ids and keys shown work for trying the
requests yourself. Long lists are shortened.

To try them, install the CLI and the plugin — see [SKILLS.md](SKILLS.md).

Skills: [fds-authority-lookup](#fds-authority-lookup) · [fds-document-digger](#fds-document-digger) · [fds-law-explorer](#fds-law-explorer) · [fds-request-finder](#fds-request-finder)

## fds-authority-lookup

> Who should I send an FOI request for air-quality measurement data in Saxony to, and do they actually answer?

```bash
fragdenstaat --compact jurisdiction list                                   # Sachsen = 89
fragdenstaat --compact publicbody search --q "Umwelt" --jurisdiction 89 --limit 50
fragdenstaat --compact publicbody get 10892
fragdenstaat --compact publicbody get 16687
fragdenstaat --compact request list --public-body 10892 --status resolved --limit 50
```

The search returned 16 bodies, including schools and a Landesstiftung. The state agency for
environmental monitoring, the LfULG, was profiled. The city of Leipzig's Immissionsschutzbehörde
is the local alternative. Its `classification` is empty.

```
Landesamt für Umwelt, Landwirtschaft und Geologie Sachsen (LfULG)
  (id 10892 · slug sachsisches-landesamt-fur-umwelt-landwirtschaft-und-geologie-lfulg)
  Type:         Umweltamt                 Jurisdiction: Sachsen
  FOI contact:  poststelle.lfulg@smekul.sachsen.de
  Address:      August-Böckstiegel-Straße 1, 01326 Dresden · Tel.: 0351 2612 0
  Note:         no request_note set, so there is no special route
  Activity:     43 requests so far
  Track record: 32 public resolved requests: 19 successful, 2 partially successful,
                4 not held, 4 refused, 3 withdrawn
  Laws:         SächsUIG (1 month_de), SächsTranspG (30 day), VIG, SächsPresseG
  Page:         fragdenstaat.de/behoerde/10892/sachsisches-landesamt-fur-umwelt-landwirtschaft-und-geologie-lfulg/

To file: open the page above and use "Anfrage stellen"; FragDenStaat sends it under the matching law.

Other matches (16 in total):
  10898  Sächsisches Staatsministerium für Energie, Klimaschutz, Umwelt und Landwirtschaft · Ministerium · 74 requests
  16687  Immissionsschutzbehörde Leipzig · no type · umweltschutz@leipzig.de · Prager Straße 118-136, 04317 Leipzig · 3 requests
  16686  Umweltamt Dresden, Immissionsschutz- und Abfallbehörde · no type · 3 requests
```

Next steps offered: the LfULG's successful requests (`--resolution successful`), or the Leipzig office's profile, if the data is about one city.

## fds-document-digger

> Which documents has the Federal Ministry of Health released through FragDenStaat this year? Export them to CSV.

```bash
fragdenstaat --compact publicbody autocomplete "Bundesministerium für Gesundheit"         # value 92
fragdenstaat --compact document list --publicbody 92 --limit 1                            # total_count 425
fragdenstaat --compact document list --publicbody 92 --created-after 2026-01-01 --limit 50  # total_count 15
fragdenstaat --compact request get 372583                                                 # likewise 365257, 365135, 371953
fragdenstaat --compact document get 277870
fragdenstaat document list --publicbody 92 --created-after 2026-01-01 --csv -o bmg-documents-2026.csv
```

Document titles are file-name slugs without umlauts (`anlage2geschwrzt`), `published_at` is
empty, and `foirequest` is an API URL rather than an id. So the skill grouped the documents by
request URL and fetched the four requests to get readable titles. `bmg-documents-2026.csv` did
not exist beforehand.

**Bundesministerium für Gesundheit (id 92)**: 425 released documents in total, **15 since
01.01.2026**, 150 pages and 9.2 MB, from 4 requests. All 4 are `resolved` / `successful` under
the IFG Bund meta-law.

| Request | Filed | Docs | Pages |
|---|---|---|---|
| 372583 Weisungen, Richtlinien, Leitfäden etc. zur Verwendung von Künstlicher Intelligenz | 2026-06-14 | 8 | 21 |
| 371953 Studie zu Alkoholwerbung | 2026-06-05 | 3 | 113 |
| 365257 Organisationspläne seit 2019 | 2026-03-12 | 1 | 8 |
| 365135 Prüfung der medizinischen Versorgung von Personen mit Geschlechtsinkongruenz und Geschlechtsdysphorie in der GKV | 2026-03-10 | 3 | 8 |

Largest file: 277824 `anlage2geschwrzt` (76 pages, 2,001,970 bytes, redacted). The AI
request produced short internal notes, for example `warnung-vor-ki-diensten-im-internet` (1 page)
and a 10-page redacted presentation on machine translation (277870,
`media.frag-den-staat.de/files/foi/1144895/…_geschwaerzt.pdf`).

Wrote 13,966 bytes to `bmg-documents-2026.csv`: 15 rows plus a header, 30 columns (`file_url`,
`num_pages`, `site_url`, `properties.author`, …). The CLI exports metadata only; downloading a
`file_url` is a separate step.

## fds-law-explorer

> Does Bavaria have a transparency law? Which law would I use to ask a Bavarian ministry, or the City of Munich, for documents?

```bash
fragdenstaat --compact jurisdiction list                         # Bayern = 92
fragdenstaat --compact law list --jurisdiction 92 --limit 50     # 4 laws
fragdenstaat --compact law get 120
fragdenstaat --compact law get 170
fragdenstaat --compact publicbody get 15890
fragdenstaat --compact law list --q "Satzung" --limit 50         # local statutes have jurisdiction null
fragdenstaat --compact law autocomplete "Informationsfreiheitssatzung der Landeshauptstadt München"   # 0 hits
fragdenstaat --compact law list --q "München" --limit 50
fragdenstaat --compact law get 51
```

Municipal Informationsfreiheitssatzungen carry no jurisdiction, so the Bayern filter misses
them. The skill found Munich's statute by searching the name instead. `legal_text` was empty
for laws 120, 170 and 51, so the deadlines and notes come from the structured fields.

**No.** Bayern has no Informationsfreiheits- or Transparenzgesetz. FragDenStaat's note on the
Bavarian meta-law (id 120) says: "In Bayern gibt es bisher kein Informationsfreiheitsgesetz …
Dazu müssen Sie allerdings (nur in Bayern) angeben, warum Sie die Information anfragen und ein
berechtigtes Interesse nachweisen … Wenn Sie nach Umweltinformationen fragen, ist dies nicht nötig."

| id | Law | Type | Deadline | Signature |
|---|---|---|---|---|
| 120 | Datenschutz-, Umwelt- und Verbraucherinformationsgesetz Bayern (BayDSG, BayUIG, VIG) | meta, bundles 119 + 3 + 170 | 1 calendar month (`month_de`) | no |
| 170 | Bayerisches Datenschutzgesetz (BayDSG) | Datenschutzrecht | 1 calendar month | no |
| 119 | Umweltinformationsgesetz Bayern (BayUIG) | UIG | 1 calendar month | no |
| 166 | Bayerisches Pressegesetz (BayPrG) | Presserecht, press only | 5 working days (`working_day`) | no |

- **A ministry:** file under law 120. For environmental information the BayUIG applies with no
  reason needed; otherwise the BayDSG route requires a legitimate interest, and its
  `refusal_reasons` begin with "berechtigtes Interesse nicht vorhanden". Mediator: Der
  Bayerische Landesbeauftragte für den Datenschutz (public body 15890).
- **City of Munich:** its own **Informationsfreiheitssatzung der Stadt München** (law 51,
  Satzung) covers "Informationen des eigenen Wirkungskreises der Stadt München". It has a
  deadline of 1 calendar month, needs no signature and has no mediator. Other Bavarian local
  statutes in the catalogue include Nürnberg (56), Schweinfurt (74), Amberg (72) and Landkreis Dachau (187).

## fds-request-finder

> How did FOI requests about Palantir go? What's the success rate?

```bash
fragdenstaat --compact request search --q "Palantir" --limit 50                 # total_count 103
fragdenstaat --compact request tags "Palantir"
fragdenstaat --compact request list --tags "Palantir" --limit 1                  # 63
fragdenstaat --compact request list --tags "Palantir" --status resolved --limit 1   # 45
fragdenstaat --compact request list --tags "Palantir" --status resolved --resolution refused --limit 1   # likewise the other 5 resolutions
fragdenstaat --compact request list --tags "Palantir" --status asleep --limit 1  # likewise awaiting_response, awaiting_classification
fragdenstaat --compact request list --tags "Palantir" --status resolved --limit 50
```

Full-text search matched 103 requests, but only 29 of the first 50 carried the `Palantir` tag.
So the skill counted on the tag with `request list`, whose `total_count` is exact. All 45
resolved requests fit on one page, which allowed a breakdown by jurisdiction.

**Requests tagged `Palantir`: 63**, of which 45 are resolved and 18 still open (11 asleep, 6
awaiting classification, 1 awaiting response).

| Outcome (resolved) | Count |
|---|---|
| refused | 25 |
| not_held | 9 |
| successful | 6 |
| partially_successful | 3 |
| user_withdrew / user_withdrew_costs | 1 / 1 |

**Success rate: 9 of 45 = 20 %** (successful plus partially successful). 56 % were refused.
Refusals by jurisdiction: Hessen 8, Nordrhein-Westfalen 5, Bund 4, Baden-Württemberg 3, Bayern 3,
Europäische Union 1, Sachsen-Anhalt 1.

- **Since 2025** (12 resolved): 7 refused, 2 not held. 2 were partially successful: 338167 on
  VeRA documents at the BW Innenministerium, and 341773 "Korrespondenz mit Palantir Technologies"
  at the NRW Innenministerium. 1 was withdrawn over costs: 336705 at the Bundesministerium des
  Innern, 500 EUR.
- **Successes:** 185344 Konzept "Palantir gegen COVID-19" (BMG, 2020), 224148 / 224161
  "Gespräche mit Palantir Technologies" (Bundespolizeipräsidium, BAMF, 2021), 259759 (LKA NRW,
  2022), 282901 (Europol) and 282902 "Mitteilung des Bundesinnenministerium zur Palantir-Absage" (2023).

These figures cover public requests only.

Next steps offered: `request get <id>` for a correspondence thread, or a CSV of all 45 resolved requests (`--csv -o palantir.csv`).
