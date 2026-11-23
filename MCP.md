# fragdenstaat-mcp

An [MCP](https://modelcontextprotocol.io/) server for [FragDenStaat.de](https://fragdenstaat.de),
the German freedom-of-information portal run by the Open Knowledge Foundation Deutschland: the
public bodies (Behörden) FOI requests go to, the public requests with their correspondence, the
documents released, and the FOI laws (IFG, UIG, VIG, state Transparenzgesetze, local Satzungen),
as tools for AI agents. Read-only, no API key, public records only. No single licence covers the
data (see Licence).

It is the MCP side of [fragdenstaat-cli](https://github.com/maschinenlesbar-org/fragdenstaat-cli),
built on the same typed client, and released with it.

## Install

```bash
npm i -g @maschinenlesbar.org/fragdenstaat-mcp
```

This installs the **`fragdenstaat-mcp`** command (Node.js 22.12+). Or run the container
image, for linux/amd64 and linux/arm64, which needs no Node.js:

```bash
docker run -i --rm ghcr.io/maschinenlesbar-org/fragdenstaat-mcp:latest
```

## Connect a client

The server speaks MCP on stdio by default.

**Claude Code**

```bash
claude mcp add fragdenstaat -- fragdenstaat-mcp
# or with the image:
claude mcp add fragdenstaat -- docker run -i --rm ghcr.io/maschinenlesbar-org/fragdenstaat-mcp:latest
```

**Claude Desktop** (`claude_desktop_config.json`)

```json
{ "mcpServers": { "fragdenstaat": { "command": "fragdenstaat-mcp" } } }
```

**VS Code** (`.vscode/mcp.json`)

```json
{ "servers": { "fragdenstaat": { "type": "stdio", "command": "fragdenstaat-mcp" } } }
```

**Over HTTP** (Streamable HTTP, one endpoint `POST /mcp`):

```bash
fragdenstaat-mcp --transport http            # http://127.0.0.1:3000/mcp
claude mcp add --transport http fragdenstaat http://127.0.0.1:3000/mcp
```

In a container, publish the port on loopback only:
`docker run --rm -p 127.0.0.1:3000:3000 ghcr.io/maschinenlesbar-org/fragdenstaat-mcp:latest --transport http --host 0.0.0.0 --allowed-hosts localhost,127.0.0.1`.

For scripts and shared configs, pin a release and its digest from the
[release notes](https://github.com/maschinenlesbar-org/fragdenstaat-cli/releases) instead of
`latest`: `…/fragdenstaat-mcp:<version>@sha256:<digest>`. Check an image's provenance with
`gh attestation verify oci://ghcr.io/maschinenlesbar-org/fragdenstaat-mcp:<version> --repo maschinenlesbar-org/fragdenstaat-cli`.

## Tools

| Tool | What it answers |
|---|---|
| `findPublicBody` | A public body by name (its FOI email and request note first, then type, jurisdiction, address, the laws that apply), or the bodies matching a topic, jurisdiction, type of body, category or point. |
| `findRequests` | FOI requests by full text or by facets (status, resolution, jurisdiction, law, body, category, type of body, tag, campaign, dates, costs), a page at a time. |
| `getRequestOutcomes` | How the matching requests went: the total, the resolved ones per resolution, the success and refusal rates over the resolved ones, a verdict. |
| `findDocuments` | Documents released through FOI by authority, request, campaign (through its requests), collection, portal, directory, tag or date: metadata and file links. |
| `findLaws` | The FOI laws of a jurisdiction, a topic or a town, each deadline with its unit in words; or one law in full, a meta law with the laws it bundles. |
| `getRequest` | One request with its correspondence: the redacted texts, the attachments, the law and its deadline; a page of messages at a time. |
| `getDocument` | One document with the text of its pages (OCR or the file's text layer), a few pages at a time. |
| `searchReference` | The names and ids the filters take: jurisdictions, categories, types of body, campaigns, request tags. |

Every tool only reads. An answer is JSON (`structuredContent` and the same as text), with the
`source` it came from (every request the answer made) and the data's terms. Names are resolved
to the ids, exact names or slugs each endpoint takes; a name that fits several is answered as
`ambiguous`, with the candidates, never one picked. A failure is a tool error that says what to
change.

## Options

```
--transport <stdio|http>   stdio (default), or Streamable HTTP on POST /mcp
--host <address>           HTTP: the address to listen on (default 127.0.0.1)
--port <n>                 HTTP: the port (default 3000)
--allowed-hosts <list>     HTTP: Host header names to answer (default localhost,127.0.0.1,[::1])
--allowed-origins <list>   HTTP: browser origins allowed to call, exactly (https://app.example.org); none by default
--auth-token-file <path>   HTTP: a file with the bearer token every request must send (mode 600, 32+ characters)
--base-url <url>           API base URL (default https://fragdenstaat.de)
--timeout <ms>             per upstream request (default 30000)
--call-timeout <ms>        per tool call, retries included (default 45000)
--max-result-chars <n>     cap on one tool result's JSON (default 25000)
--max-pages <n>            pages a tool reads per list and call (default 10)
--user-agent <ua>          User-Agent header value
--log-format <text|jsonl>  the log records on stderr (default text)
```

## What it does and doesn't do

- **Read-only.** No tool changes anything, here or upstream.
- **No authentication** on HTTP unless you give one. It listens on loopback by default; it checks
  the `Host` header and, from a browser, the `Origin` (only the origins given with
  `--allowed-origins`, matched exactly) against DNS rebinding and other web pages; a page on one of
  those origins gets CORS (its preflight answered, the answers readable). With `--auth-token-file
  <path>` every request must send `Authorization: Bearer <token>` (the file holds one token of at
  least 32 characters, mode 600, owned by the user the server runs as; read once at start; `(umask
  077; openssl rand -hex 32 > mcp-token)` makes one); anything else is answered 401. Exposed beyond
  localhost (it logs a warning then), it belongs behind a proxy that authenticates or at least
  terminates TLS.
- **Gentle with the upstream.** One server process sends at most 2 requests at a time and 120 a
  minute to the API, pauses on HTTP 429 (as long as its Retry-After asks, at most 30 s), and stops a
  tool call after its deadline (a tool that has read part of its answer by then may answer with that
  part, and says so). A request those limits would hold longer than it or its call may wait is not
  sent: the call fails at once, naming the limit and when to ask again (and the log says so).
- **Results are data.** Text from the API is cleaned (control, bidi and zero-width characters
  removed), but it is still other people's text: a model can be told things in it. The server
  can't act on that (it has no tool that writes), but other tools in the same session could.
- **Stops cleanly.** On `docker stop` (SIGTERM) or Ctrl-C the HTTP server takes no new connection
  and lets calls in flight answer for up to 5 s, then exits 143 (130); a second signal ends it at
  once. On stdio a signal ends it at once; when stdin ends, it first answers the requests it has
  read (each within its call deadline), then exits.
- **In a container** it needs at least 12 processes and threads (`--pids-limit`) and about
  256 MB of memory. The largest answers it reads, a long request thread or a document of
  hundreds of pages with their text, are a few MB.
- **Personal data.** Requests and answers name people; the platform redacts them
  (`[geschwärzt]`, `<< Anfragesteller:in >>`). The tools pass the redacted texts and never the
  signed file links of attachments.
- **Logs** go to stderr, one record per line; stdout carries only the protocol. A call that fails
  upstream or reaches its deadline leaves a WARN record naming the tool.
- **Never installs anything.**

## Licence

Code: AGPL-3.0-or-later or commercial
([LICENSING.md](https://github.com/maschinenlesbar-org/fragdenstaat-cli/blob/main/LICENSING.md)).
Data: there is no single licence over FragDenStaat's data, and the API gives none per record
([DATA_LICENSE.md](https://github.com/maschinenlesbar-org/fragdenstaat-cli/blob/main/DATA_LICENSE.md)).
Under the [terms of use](https://fragdenstaat.de/nutzungsbedingungen/) (§ 5), request texts and
other user contributions are CC0 1.0; authority answers and the documents released are presumed
public-domain official works (§ 5 UrhG, "in der Regel"), but an attachment can carry third-party
rights; and requests and answers hold personal data, so the GDPR applies to reusing them (prefer
the redacted texts). Every result carries this note in its `licence` field. We provide the tool,
not the data: check a record's source before republishing it, and running the server as a service
for others may need the Open Knowledge Foundation Deutschland's permission.
