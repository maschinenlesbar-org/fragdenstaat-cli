# Beispiele

Echte Beispiele für die Claude-Code-Skills des Plugins `fragdenstaat`, eines pro Skill: eine
Anfrage, die `fragdenstaat`-Befehle, die der Skill ausgeführt hat, und Claudes Antwort.

Jedes Beispiel lief am 15. September 2026 mit `fragdenstaat` 0.0.7 gegen die Live-API.
Die Daten ändern sich, Ihre Ergebnisse werden also abweichen; mit den gezeigten IDs und
Schlüsseln können Sie die Anfragen selbst ausprobieren. Lange Listen sind gekürzt.

Zum Ausprobieren installieren Sie die CLI und das Plugin – siehe [SKILLS.md](SKILLS.md) (englisch).

Skills: [fds-authority-lookup](#fds-authority-lookup) · [fds-document-digger](#fds-document-digger) · [fds-law-explorer](#fds-law-explorer) · [fds-request-finder](#fds-request-finder)

## fds-authority-lookup

> An welche Behörde richtet man in Sachsen eine IFG-Anfrage zu Luftqualitäts-Messdaten, und antwortet sie überhaupt?

```bash
fragdenstaat --compact jurisdiction list                                   # Sachsen = 89
fragdenstaat --compact publicbody search --q "Umwelt" --jurisdiction 89 --limit 50
fragdenstaat --compact publicbody get 10892
fragdenstaat --compact publicbody get 16687
fragdenstaat --compact request list --public-body 10892 --status resolved --limit 50
```

Die Suche lieferte 16 Stellen, darunter Schulen und eine Landesstiftung. Profiliert wurde das
LfULG als die für Umweltmessungen zuständige Landesbehörde. Die Leipziger
Immissionsschutzbehörde ist die kommunale Alternative; ihre `classification` ist leer.

```
Landesamt für Umwelt, Landwirtschaft und Geologie Sachsen (LfULG)
  (id 10892 · slug sachsisches-landesamt-fur-umwelt-landwirtschaft-und-geologie-lfulg)
  Typ:          Umweltamt                 Zuständig: Sachsen
  FOI-Kontakt:  poststelle.lfulg@smekul.sachsen.de
  Adresse:      August-Böckstiegel-Straße 1, 01326 Dresden · Tel.: 0351 2612 0
  Hinweis:      kein request_note hinterlegt, also kein besonderer Weg
  Aktivität:    43 Anfragen bisher
  Bilanz:       32 öffentliche abgeschlossene Anfragen: 19 erfolgreich, 2 teilweise erfolgreich,
                4 Information nicht vorhanden, 4 abgelehnt, 3 zurückgezogen
  Gesetze:      SächsUIG (1 month_de), SächsTranspG (30 day), VIG, SächsPresseG
  Seite:        fragdenstaat.de/behoerde/10892/sachsisches-landesamt-fur-umwelt-landwirtschaft-und-geologie-lfulg/

Zum Stellen: die Seite oben öffnen und „Anfrage stellen" wählen – FragDenStaat verschickt sie nach dem passenden Gesetz.

Weitere Treffer (16 insgesamt):
  10898  Sächsisches Staatsministerium für Energie, Klimaschutz, Umwelt und Landwirtschaft · Ministerium · 74 Anfragen
  16687  Immissionsschutzbehörde Leipzig · kein Typ · umweltschutz@leipzig.de · Prager Straße 118-136, 04317 Leipzig · 3 Anfragen
  16686  Umweltamt Dresden, Immissionsschutz- und Abfallbehörde · kein Typ · 3 Anfragen
```

Als Nächstes angeboten: die erfolgreichen Anfragen an das LfULG (`--resolution successful`) oder das Profil der Leipziger Behörde, falls es nur um eine Stadt geht.

## fds-document-digger

> Welche Dokumente hat das Bundesministerium für Gesundheit dieses Jahr über FragDenStaat herausgegeben? Bitte als CSV exportieren.

```bash
fragdenstaat --compact publicbody autocomplete "Bundesministerium für Gesundheit"         # value 92
fragdenstaat --compact document list --publicbody 92 --limit 1                            # total_count 425
fragdenstaat --compact document list --publicbody 92 --created-after 2026-01-01 --limit 50  # total_count 15
fragdenstaat --compact request get 372583                                                 # ebenso 365257, 365135, 371953
fragdenstaat --compact document get 277870
fragdenstaat document list --publicbody 92 --created-after 2026-01-01 --csv -o bmg-documents-2026.csv
```

Die Dokumenttitel sind Dateinamen-Slugs ohne Umlaute (`anlage2geschwrzt`), `published_at` ist
leer, und `foirequest` ist eine API-URL statt einer ID. Deshalb hat der Skill die Dokumente nach
Anfrage-URL gruppiert und die vier Anfragen abgerufen, um lesbare Titel zu bekommen.
`bmg-documents-2026.csv` gab es vorher noch nicht.

**Bundesministerium für Gesundheit (id 92)**: insgesamt 425 herausgegebene Dokumente, **15 seit
01.01.2026**, 150 Seiten und 9,2 MB aus 4 Anfragen. Alle 4 sind `resolved` / `successful` nach
dem Meta-Gesetz IFG Bund.

| Anfrage | Gestellt | Dok. | Seiten |
|---|---|---|---|
| 372583 Weisungen, Richtlinien, Leitfäden etc. zur Verwendung von Künstlicher Intelligenz | 2026-06-14 | 8 | 21 |
| 371953 Studie zu Alkoholwerbung | 2026-06-05 | 3 | 113 |
| 365257 Organisationspläne seit 2019 | 2026-03-12 | 1 | 8 |
| 365135 Prüfung der medizinischen Versorgung von Personen mit Geschlechtsinkongruenz und Geschlechtsdysphorie in der GKV | 2026-03-10 | 3 | 8 |

Größte Datei: 277824 `anlage2geschwrzt` (76 Seiten, 2.001.970 Bytes, geschwärzt). Die KI-Anfrage
brachte kurze interne Hinweise hervor, etwa `warnung-vor-ki-diensten-im-internet` (1 Seite), und
eine 10-seitige geschwärzte Präsentation zur maschinellen Übersetzung (277870,
`media.frag-den-staat.de/files/foi/1144895/…_geschwaerzt.pdf`).

13.966 Bytes nach `bmg-documents-2026.csv` geschrieben: 15 Zeilen plus Kopfzeile, 30 Spalten
(`file_url`, `num_pages`, `site_url`, `properties.author`, …). Die CLI exportiert nur Metadaten;
das Herunterladen einer `file_url` ist ein eigener Schritt.

## fds-law-explorer

> Hat Bayern ein Transparenzgesetz? Nach welchem Gesetz kann man bei einem bayerischen Ministerium oder bei der Stadt München Unterlagen anfragen?

```bash
fragdenstaat --compact jurisdiction list                         # Bayern = 92
fragdenstaat --compact law list --jurisdiction 92 --limit 50     # 4 Gesetze
fragdenstaat --compact law get 120
fragdenstaat --compact law get 170
fragdenstaat --compact publicbody get 15890
fragdenstaat --compact law list --q "Satzung" --limit 50         # kommunale Satzungen haben jurisdiction null
fragdenstaat --compact law autocomplete "Informationsfreiheitssatzung der Landeshauptstadt München"   # 0 Treffer
fragdenstaat --compact law list --q "München" --limit 50
fragdenstaat --compact law get 51
```

Kommunale Informationsfreiheitssatzungen haben keine Zuständigkeit zugeordnet, deshalb fehlen
sie im Bayern-Filter. Der Skill fand die Münchner Satzung stattdessen über die Namenssuche.
`legal_text` war bei den Gesetzen 120, 170 und 51 leer; Fristen und Hinweise stammen daher aus
den strukturierten Feldern.

**Nein.** Bayern hat weder ein Informationsfreiheits- noch ein Transparenzgesetz. Der Hinweis
von FragDenStaat zum bayerischen Meta-Gesetz (id 120) lautet: „In Bayern gibt es bisher kein
Informationsfreiheitsgesetz … Dazu müssen Sie allerdings (nur in Bayern) angeben, warum Sie die
Information anfragen und ein berechtigtes Interesse nachweisen … Wenn Sie nach
Umweltinformationen fragen, ist dies nicht nötig."

| id | Gesetz | Art | Frist | Unterschrift |
|---|---|---|---|---|
| 120 | Datenschutz-, Umwelt- und Verbraucherinformationsgesetz Bayern (BayDSG, BayUIG, VIG) | Meta, bündelt 119 + 3 + 170 | 1 Kalendermonat (`month_de`) | nein |
| 170 | Bayerisches Datenschutzgesetz (BayDSG) | Datenschutzrecht | 1 Kalendermonat | nein |
| 119 | Umweltinformationsgesetz Bayern (BayUIG) | UIG | 1 Kalendermonat | nein |
| 166 | Bayerisches Pressegesetz (BayPrG) | Presserecht, nur für Presse | 5 Arbeitstage (`working_day`) | nein |

- **Ein Ministerium:** Anfrage nach Gesetz 120. Für Umweltinformationen gilt das BayUIG ohne
  Begründung; sonst verlangt der Weg über das BayDSG ein berechtigtes Interesse, und seine
  `refusal_reasons` beginnen mit „berechtigtes Interesse nicht vorhanden". Vermittlungsstelle:
  Der Bayerische Landesbeauftragte für den Datenschutz (Behörde 15890).
- **Stadt München:** eigene **Informationsfreiheitssatzung der Stadt München** (Gesetz 51,
  Satzung) für „Informationen des eigenen Wirkungskreises der Stadt München". Frist 1
  Kalendermonat, keine Unterschrift, keine Vermittlungsstelle. Weitere bayerische Satzungen im
  Katalog sind u. a. Nürnberg (56), Schweinfurt (74), Amberg (72) und Landkreis Dachau (187).

## fds-request-finder

> Wie sind IFG-Anfragen zu Palantir ausgegangen? Wie hoch ist die Erfolgsquote?

```bash
fragdenstaat --compact request search --q "Palantir" --limit 50                 # total_count 103
fragdenstaat --compact request tags "Palantir"
fragdenstaat --compact request list --tags "Palantir" --limit 1                  # 63
fragdenstaat --compact request list --tags "Palantir" --status resolved --limit 1   # 45
fragdenstaat --compact request list --tags "Palantir" --status resolved --resolution refused --limit 1   # ebenso die anderen 5 Ergebnisse
fragdenstaat --compact request list --tags "Palantir" --status asleep --limit 1  # ebenso awaiting_response, awaiting_classification
fragdenstaat --compact request list --tags "Palantir" --status resolved --limit 50
```

Die Volltextsuche fand 103 Anfragen, aber nur 29 der ersten 50 trugen das Tag `Palantir`. Der
Skill hat deshalb über das Tag mit `request list` gezählt, dessen `total_count` exakt ist. Alle 45
abgeschlossenen Anfragen passten auf eine Seite; so ließ sich auch nach Zuständigkeit aufschlüsseln.

**Anfragen mit Tag `Palantir`: 63**, davon 45 abgeschlossen und 18 noch offen (11 ruhend, 6 warten
auf Einstufung, 1 wartet auf Antwort).

| Ergebnis (abgeschlossen) | Anzahl |
|---|---|
| refused | 25 |
| not_held | 9 |
| successful | 6 |
| partially_successful | 3 |
| user_withdrew / user_withdrew_costs | 1 / 1 |

**Erfolgsquote: 9 von 45 = 20 %** (erfolgreich plus teilweise erfolgreich). 56 % wurden abgelehnt.
Ablehnungen nach Zuständigkeit: Hessen 8, Nordrhein-Westfalen 5, Bund 4, Baden-Württemberg 3,
Bayern 3, Europäische Union 1, Sachsen-Anhalt 1.

- **Seit 2025** (12 abgeschlossen): 7 abgelehnt, 2 Information nicht vorhanden. 2 teilweise
  erfolgreich: 338167 zu VeRA-Unterlagen beim Innenministerium BW und 341773 „Korrespondenz mit
  Palantir Technologies" beim Innenministerium NRW. 1 wegen Kosten zurückgezogen: 336705 beim
  Bundesministerium des Innern, 500 EUR.
- **Erfolge:** 185344 Konzept „Palantir gegen COVID-19" (BMG, 2020), 224148 / 224161 „Gespräche
  mit Palantir Technologies" (Bundespolizeipräsidium, BAMF, 2021), 259759 (LKA NRW, 2022), 282901
  (Europol) und 282902 „Mitteilung des Bundesinnenministerium zur Palantir-Absage" (2023).

Die Zahlen umfassen nur öffentliche Anfragen.

Als Nächstes angeboten: `request get <id>` für einen Schriftverkehr oder eine CSV aller 45 abgeschlossenen Anfragen (`--csv -o palantir.csv`).
