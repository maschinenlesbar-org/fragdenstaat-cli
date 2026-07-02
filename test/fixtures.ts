// Canned response bodies used across the unit tests. Shapes mirror the live
// Tastypie API (a `{ meta, objects }` list envelope, bare detail objects,
// `{ value, label }` autocomplete items) but are trimmed to the fields the tests
// actually assert on.

export function meta(total_count: number, limit = 20, offset = 0) {
  return {
    limit,
    offset,
    total_count,
    next: offset + limit < total_count
      ? `https://fragdenstaat.de/api/v1/request/?limit=${limit}&offset=${offset + limit}`
      : null,
    previous: null,
  };
}

export const requestList = {
  meta: meta(284836, 1, 0),
  objects: [
    {
      resource_uri: "https://fragdenstaat.de/api/v1/request/1/",
      id: 1,
      title: "Test-Anfrage",
      slug: "test-anfrage",
      jurisdiction: "https://fragdenstaat.de/api/v1/jurisdiction/1/",
      jurisdiction_name: "Bund",
      law: "https://fragdenstaat.de/api/v1/law/1/",
      status: "resolved",
      resolution: "successful",
      public: true,
      tags: ["umwelt"],
      created_at: "2024-01-01T00:00:00+01:00",
    },
  ],
};

export const requestDetail = {
  resource_uri: "https://fragdenstaat.de/api/v1/request/1/",
  id: 1,
  title: "Test-Anfrage",
  status: "resolved",
  resolution: "successful",
  messages: [{ id: 10, kind: "email", is_response: false }],
};

export const publicBodyList = {
  meta: meta(42234, 1, 0),
  objects: [
    {
      resource_uri: "https://fragdenstaat.de/api/v1/publicbody/1/",
      id: 1,
      name: "Umweltbundesamt",
      slug: "umweltbundesamt",
      jurisdiction: "https://fragdenstaat.de/api/v1/jurisdiction/1/",
      number_of_requests: 42,
    },
  ],
};

export const lawList = {
  meta: meta(189, 1, 0),
  objects: [{ resource_uri: "https://fragdenstaat.de/api/v1/law/1/", id: 1, name: "IFG", meta: false }],
};

export const jurisdictionList = {
  meta: meta(18, 20, 0),
  objects: [
    { resource_uri: "https://fragdenstaat.de/api/v1/jurisdiction/1/", id: 1, name: "Bund", slug: "bund" },
  ],
};

export const autocomplete = {
  meta: meta(1, 50, 0),
  objects: [{ value: 42, label: "Umweltbundesamt" }],
};

export const tagsAutocomplete = {
  meta: meta(1, 50, 0),
  objects: [{ value: "lobbyismus", label: "lobbyismus" }],
};

export const csvBody =
  "id,title,status\r\n1,Test-Anfrage,resolved\r\n2,Zweite Anfrage,awaiting_response\r\n";

// Error bodies — the two shapes the API emits.
export const notFound = { detail: "No FoiRequest matches the given query." };
// The field->messages 400 shape, keyed by the offending filter (here `status`).
export const validation400 = {
  status: ["Bitte eine gültige Auswahl treffen. bogus ist keine gültige Auswahl."],
};
// What `document list --tag <non-id>` actually returns — keyed on `tag`.
export const documentTag400 = {
  tag: ["Bitte eine gültige Auswahl treffen. Dies ist keine gültige Auswahl."],
};
export const accept406 = { detail: "Kann die Accept Kopfzeile der Anfrage nicht erfüllen." };
