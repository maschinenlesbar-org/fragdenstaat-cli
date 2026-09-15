# Glossar

Fachbegriffe der FragDenStaat.de-API mit den deutschen Bezeichnungen. Enum-Werte sind die
unveränderten Maschinenwerte; die deutschen Bezeichnungen gibt die API in den Feldern
`readable_status` / `*_name` zurück.

## Die Plattform

**FragDenStaat.de** – das zentrale deutsche Portal für *Informationsfreiheit*, betrieben von
der **Open Knowledge Foundation Deutschland e.V.** Nutzerinnen und Nutzer stellen dort
Anfragen an Behörden; die Plattform verschickt sie per E-Mail, empfängt die Antworten
und veröffentlicht Anfrage und Antwort. Die zugrunde liegende Software ist
[**Froide**](https://github.com/okfde/froide) (Open Source, MIT).

**Informationsfreiheitsanfrage** – der Antrag einer Bürgerin oder eines Bürgers auf Zugang zu
Unterlagen einer Behörde auf Grundlage eines Informationsfreiheitsgesetzes. Die zentrale
Ressource der API (`request`), rund 285.000 Stück.

## Lebenszyklus einer Anfrage – `status`

Das Feld `status` einer Anfrage; die deutsche Bezeichnung steht in `readable_status`.

| Wert | Deutsche Bezeichnung | Bedeutung |
|---|---|---|
| `awaiting_user_confirmation` | Warte auf Nutzerbestätigung | Angelegt; wartet vor dem Versand auf die Bestätigung durch den Nutzer. |
| `publicbody_needed` | Behörde benötigt | Noch keine empfangende Behörde ausgewählt. |
| `awaiting_publicbody_confirmation` | Warte auf Bestätigung der Behörde | An eine Behörde gesendet, deren Adresse oder Existenz nicht bestätigt ist. |
| `awaiting_response` | Warte auf Antwort | Zugestellt; wartet auf die Antwort – der normale offene Zustand. |
| `awaiting_classification` | Anfrage muss klassifiziert werden | Eine Antwort ist eingegangen; der Nutzer muss das Ergebnis festlegen. |
| `asleep` | Anfrage eingeschlafen | Ruhend – seit Langem keine Aktivität. |
| `resolved` | Anfrage abgeschlossen | Abgeschlossen; ein endgültiges Ergebnis ist gesetzt. |

## Ergebnis – `resolution`

Nur aussagekräftig, sobald `status = resolved` gilt; sonst ein **leerer String `""`**.

| Wert | Deutsche Bezeichnung | Bedeutung |
|---|---|---|
| `successful` | Anfrage erfolgreich | Die Informationen wurden vollständig herausgegeben. |
| `partially_successful` | Anfrage teilweise erfolgreich | Teils herausgegeben, teils zurückgehalten. |
| `not_held` | Information nicht vorhanden | Die Behörde verfügt nicht über die Information. |
| `refused` | Anfrage abgelehnt | Zugang verweigert (siehe `refusal_reason`). |
| `user_withdrew` | Anfrage zurückgezogen | Die anfragende Person hat sie zurückgezogen. |
| `user_withdrew_costs` | Zurückgezogen wegen Kosten | Wegen der geforderten Gebühren zurückgezogen. |

## Informationsfreiheitsgesetze – `law`

FragDenStaat bildet **rund 189** verschiedene Rechtsgrundlagen auf Bundes-, Landes- und
kommunaler Ebene ab. Die drei Säulen auf Bundesebene:

- **IFG** – *Informationsfreiheitsgesetz*: allgemeiner Zugang zu amtlichen Informationen
  der Bundesverwaltung.
- **UIG** – *Umweltinformationsgesetz*: Zugang zu Umweltinformationen (setzt die Vorgaben
  der EU und der Aarhus-Konvention um; die Länder haben eigene Gesetze,
  z. B. das HUIG in Hessen).
- **VIG** – *Verbraucherinformationsgesetz*: Zugang zu Informationen über
  Verbraucherschutz und Lebensmittelsicherheit.

Die meisten *Länder* haben ein eigenes IFG oder **Transparenzgesetz**, aber nicht alle:
Für Bayern und Niedersachsen führt der Katalog keines von beiden (Stand 15.09.2026). Viele
Kreise und Gemeinden ergänzen eine kommunale *Informationsfreiheitssatzung* – deshalb sind
es 189 und nicht 3. Ein **Meta-Gesetz** (`meta: true`) bündelt mehrere Gesetze, auf die sich
eine Anfrage gemeinsam stützen kann (`combined[]` listet sie auf). Zu jedem Gesetz sind die
gesetzliche Antwortfrist `max_response_time` (+ `max_response_time_unit`, z. B. *working_day*,
*month_de*) und die Angabe hinterlegt, ob es eine Unterschrift verlangt (`requires_signature`).

## Zuständigkeit – `jurisdiction`

Der rechtliche und räumliche Bereich, zu dem eine Behörde und das für sie geltende Gesetz
gehören. Insgesamt **18**: der **Bund**, die **16 Länder** und die **Europäische Union**.
Kommunale *Informationsfreiheitssatzungen* haben `jurisdiction: null`; ein Filter auf die
Zuständigkeit eines Landes liefert sie daher nicht.

## Weitere Ressourcen

| Begriff (englisch) | Deutsch | Endpoint | Was es ist |
|---|---|---|---|
| Public body | Behörde | `publicbody` | Eine Stelle, die Anfragen empfängt; hat `email`, `address`, `classification`, `jurisdiction`, `number_of_requests`. |
| Classification | Behördentyp | `classification` | Hierarchische Taxonomie der *Art* von Behörde (Ministerium, Grundschule, …). |
| Category | Thema | `category` | Hierarchische *Themen*-Taxonomie (Flag `is_topic`) für Anfragen und Behörden. |
| Geo-region | Region | `georegion` | Ein geografisches Gebiet mit einem `kind`: country/state/district/municipality/zipcode… (rund 24.000). |
| Campaign | Kampagne | `campaign` | Ein koordiniertes Projekt mit vielen gleichartigen Anfragen (z. B. „Frag den Bundestag“). |
| Message | Nachricht | `message` | Ein einzelnes Schreiben innerhalb einer Anfrage; `kind` = email/post/fax/upload/phone/visit/import. |
| Document | Dokument | `document` | Eine veröffentlichte (oft per OCR erfasste) Datei aus Antworten auf Anfragen; hat `pages`. |
| Attachment | Anhang | (eingebettet) | Eine Datei an einer Nachricht; kann im Original und in geschwärzter Fassung vorliegen. |

## Das Übertragungsformat (Tastypie)

- **Listen**-Antworten sind eine Hülle `{ meta, objects }`. `meta` = `{ limit, offset,
  total_count, next, previous }`; `next`/`previous` sind vollständige Seiten-URLs oder `null`.
- **Detail**-Antworten sind das bloße Objekt.
- Verknüpfte Ressourcen werden als absolute `resource_uri`-URLs **verlinkt**, nicht eingebettet
  (Ausnahmen: das verschachtelte `public_body` einer Anfrage sowie Detail-Antworten, die
  `law`/`public_body`/`messages` direkt enthalten).
- Die Seitengröße (`limit`) ist serverseitig **fest auf 50 begrenzt**; blättern Sie mit `offset`.
- `redacted_description` und die `redacted_*`-Felder enthalten die geschwärzten Fassungen –
  verwenden Sie bevorzugt diese, wenn Sie Inhalte weiterveröffentlichen (der Datenbestand
  enthält personenbezogene Daten).
