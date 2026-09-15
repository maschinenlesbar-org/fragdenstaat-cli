# Glossary

Domain terms for the FragDenStaat.de API, in English with the German term. Enum
values are the verbatim machine values; German labels are what the API returns in
`readable_status` / `*_name` fields.

## The platform

**FragDenStaat.de** — Germany's central Freedom-of-Information (*Informationsfreiheit*)
portal, run by the **Open Knowledge Foundation Deutschland e.V.** Users file FOI
requests to public bodies; the platform sends them by email, receives the replies,
and publishes both request and response. The underlying software is
[**Froide**](https://github.com/okfde/froide) (open source, MIT).

**FOI request** (*Informationsfreiheitsanfrage*) — a citizen's request for access to
records held by a public body, under a Freedom-of-Information law. The central
resource of the API (`request`), ~285,000 of them.

## Request lifecycle — `status`

The `status` field on a request; the German label comes back in `readable_status`.

| Value | German label | Meaning |
|---|---|---|
| `awaiting_user_confirmation` | Warte auf Nutzerbestätigung | Created; waiting for the user to confirm before it is sent. |
| `publicbody_needed` | Behörde benötigt | No recipient body chosen yet. |
| `awaiting_publicbody_confirmation` | Warte auf Bestätigung der Behörde | Sent to a body whose address/existence is unconfirmed. |
| `awaiting_response` | Warte auf Antwort | Delivered; waiting for the reply — the normal open state. |
| `awaiting_classification` | Anfrage muss klassifiziert werden | A reply arrived; the user must set the outcome. |
| `asleep` | Anfrage eingeschlafen | Dormant — no activity for a long time. |
| `resolved` | Anfrage abgeschlossen | Closed; a final resolution has been set. |

## Outcome — `resolution`

Only meaningful once `status = resolved`; an **empty string `""`** otherwise.

| Value | German label | Meaning |
|---|---|---|
| `successful` | Anfrage erfolgreich | Information was provided in full. |
| `partially_successful` | Anfrage teilweise erfolgreich | Some provided, some withheld. |
| `not_held` | Information nicht vorhanden | The body does not hold the information. |
| `refused` | Anfrage abgelehnt | Access denied (see `refusal_reason`). |
| `user_withdrew` | Anfrage zurückgezogen | The requester withdrew it. |
| `user_withdrew_costs` | Zurückgezogen wegen Kosten | Withdrawn because of the fees demanded. |

## FOI laws — `law`

FragDenStaat models **~189** distinct legal bases across federal, state, and local
level. The three federal pillars:

- **IFG** — *Informationsfreiheitsgesetz* (Freedom of Information Act): general
  access to federal-government records.
- **UIG** — *Umweltinformationsgesetz* (Environmental Information Act): access to
  environmental information (implements the EU/Aarhus regime; states have their own,
  e.g. HUIG in Hessen).
- **VIG** — *Verbraucherinformationsgesetz* (Consumer Information Act): access to
  consumer-protection / food-safety information.

Most *Länder* have their own IFG or **Transparenzgesetz** (transparency act), but
not all: the catalogue lists neither for Bayern or Niedersachsen (checked
2026-09-15). Many districts/municipalities add a local *Informationsfreiheitssatzung*
— which is why the count is 189, not 3. A **meta law** (`meta: true`) bundles several laws a
requester can invoke together (`combined[]` lists them). Each law records a statutory
`max_response_time` (+ `max_response_time_unit`, e.g. *working_day*, *month_de*) and
whether it `requires_signature`.

## Jurisdiction — `jurisdiction`

The legal/territorial scope a public body and its applicable law belong to. **18**
in total: **Bund** (federal), the **16 Länder**, and the **Europäische Union**.
Local *Informationsfreiheitssatzungen* have `jurisdiction: null`, so filtering laws
by a Land's jurisdiction does not return them.

## Other resources

| Term | German | Endpoint | What it is |
|---|---|---|---|
| Public body | Behörde | `publicbody` | An authority that receives requests; has `email`, `address`, `classification`, `jurisdiction`, `number_of_requests`. |
| Classification | Behördentyp | `classification` | Hierarchical taxonomy of the *type* of body (Ministerium, Grundschule, …). |
| Category | Thema | `category` | Hierarchical *topic* taxonomy (`is_topic` flag) for requests/bodies. |
| Geo-region | Region | `georegion` | A geographic area with a `kind`: country/state/district/municipality/zipcode… (~24,000). |
| Campaign | Kampagne | `campaign` | A coordinated mass-request project (e.g. "Frag den Bundestag"). |
| Message | Nachricht | `message` | One piece of correspondence within a request; `kind` = email/post/fax/upload/phone/visit/import. |
| Document | Dokument | `document` | A published (often OCR'd) file extracted from FOI responses; has `pages`. |
| Attachment | Anhang | (embedded) | A file on a message; may exist in original and redacted variants. |

## The wire format (Tastypie)

- **List** responses are a `{ meta, objects }` envelope. `meta` = `{ limit, offset,
  total_count, next, previous }`; `next`/`previous` are full page URLs or `null`.
- **Detail** responses are the bare object.
- Related resources are **hyperlinked** as absolute `resource_uri` URLs, not embedded
  (except a request's `public_body`, which is nested; and detail responses that inline
  `law`/`public_body`/`messages`).
- Page size (`limit`) is **hard-capped at 50** by the server; page with `offset`.
- `redacted_description` and `redacted_*` fields carry the redaction-safe variants —
  prefer them for republication (the corpus contains personal data).
