# Data license

> **This tool does not include, host, or redistribute any data.**
> `fragdenstaat-cli` is a *client*. It only accesses data served live by
> **FragDenStaat.de**, operated by the **Open Knowledge Foundation Deutschland
> e.V.** That data is the provider's (and the requesters'/authorities') and is
> governed by **their** terms. The license of this CLI's own source code is a
> separate matter — see [LICENSING.md](LICENSING.md).

> [!IMPORTANT]
> **There is no single blanket license over all FragDenStaat data.** The corpus is
> a *mix* of three regimes (authority responses, user contributions, personal
> data). Do not assume uniform open terms — check the source before republishing.

| | |
|---|---|
| **Data provider** | Open Knowledge Foundation Deutschland e.V. (the FragDenStaat project) |
| **API / source** | `https://fragdenstaat.de/api/v1/` — a Froide (django-tastypie) read API |
| **Software** | [Froide](https://github.com/okfde/froide) — the platform software, **MIT-licensed** (a *code* license, distinct from the data terms below) |
| **Canonical terms** | Nutzungsbedingungen (Terms of Use), §5: https://fragdenstaat.de/nutzungsbedingungen/ |
| **Attribution** | **Not legally required** — user contributions are CC0 and reuse is explicitly "ohne Bedingungen" (see §5.3). A courtesy credit is welcome, not mandatory. |
| **Rate limit** | **No published limit.** Be a good citizen: descriptive User-Agent, back off on 429/503, don't hammer. |

## The three regimes

### 1. Authority responses (Behördenantworten) — presumed public-domain *amtliche Werke*

The operator *assumes* authority responses are, as a rule, public-domain "official
works" under §5 UrhG **[Terms §5.1]**:

> „Hinsichtlich der Behördenantworten geht die Betreiberin davon aus, dass diese in
> der Regel als ‚amtliche Werke' im Sinne des § 5 Urheberrechtsgesetz gemeinfrei
> sind."

Note the hedge — *"in der Regel"* (as a rule), not a guarantee. Individual attached
documents may still carry third-party rights.

### 2. User-written requests and contributions — CC0 1.0

Request texts and other user contributions are dedicated to the public domain under
**CC0 1.0** **[Terms §5.2]**:

> „Mit dem Einbringen eigener Beiträge und Anfragen geben Sie etwaige Rechte an
> diesem Material … zugleich umfassend gemäß der Freigabeerklärung ‚CC0' (auch
> genannt ‚CC Zero') auf bzw. frei."

Reuse carries **no conditions** **[Terms §5.3]** — *"Auch Dritte können die so
freigegebenen Inhalte ohne Bedingungen nachnutzen"* — and the release is
irrevocable **[Terms §5.4]**. CC0 deed (as linked by the terms):
`http://creativecommons.org/publicdomain/zero/1.0/deed.de`.

### 3. Personal data — present throughout; GDPR/DSGVO applies

FOI requests contain personal data. The API reflects this, and so should you:

- Prefer **`redacted_description`** over `description`, and redacted attachments
  over originals, when republishing. In live data `redacted_description` is a list
  of `[isRedacted, textSegment]` pairs.
- Messages carry `content_hidden` / `redacted` / `not_publishable` flags;
  attachments carry `is_redacted`.
- On account deletion, retained public content is **anonymised**, not removed
  **[Terms §5.4]**.

Treat the corpus as containing personal data subject to the GDPR/DSGVO. General
privacy policy: https://fragdenstaat.de/datenschutzerklaerung/.

## Framing

We provide the **tool**, not the data. Access is read-only and public, but the
three regimes above are not interchangeable — **verify terms at the source before
republishing**, especially for authority attachments (possible third-party rights)
and anything containing personal data.

## Sources

- Terms of Use (canonical, §5): https://fragdenstaat.de/nutzungsbedingungen/
- API index & developer docs: https://fragdenstaat.de/api/
- Privacy policy: https://fragdenstaat.de/datenschutzerklaerung/
- Froide software (MIT): https://github.com/okfde/froide
- CC0 1.0 deed referenced by the terms: http://creativecommons.org/publicdomain/zero/1.0/deed.de

---

*Good-faith summary compiled 2026-07-02; not legal advice. The provider publishes no
single blanket data license — the above reflects the Nutzungsbedingungen as of that
date. Verify directly at the source before any reuse beyond personal/evaluation.*
