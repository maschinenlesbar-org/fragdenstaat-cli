import { Command } from "commander";
import type { CliDeps } from "../io.js";
import {
  action,
  addPagination,
  choiceOption,
  once,
  onceValue,
  paginationParams,
  parseCampaign,
  parseIdFilter,
  parseNonEmpty,
  parseNonNegativeNumber,
  pruneUndefined,
  renderCsvPage,
  renderJson,
} from "../shared.js";
import { CSV_HELP, addList, addGet, asBool } from "./common.js";
import type { QueryParams } from "../../client/query.js";
import { RequestStatusValues, RequestResolutionValues } from "../../client/enums.js";

function addRequestFilters(cmd: Command): Command {
  return cmd
    .addOption(choiceOption("--status <status>", "filter by lifecycle status", RequestStatusValues))
    .addOption(
      choiceOption("--resolution <resolution>", "filter by outcome (resolved requests)", RequestResolutionValues),
    )
    .option("--jurisdiction <id>", "filter by jurisdiction id", once(parseIdFilter))
    .option("--law <id>", "filter by FOI law id", once(parseIdFilter))
    .option(
      "--categories <name>",
      'filter by the exact category name, case-sensitive (e.g. "Umwelt"; not an id or slug)',
      once(parseNonEmpty),
    )
    .option(
      "--classification <name>",
      'filter by the exact public-body classification name, case-sensitive (e.g. "Ministerium")',
      once(parseNonEmpty),
    )
    .option("--campaign <id>", 'filter by campaign id ("-" = requests in no campaign)', once(parseCampaign))
    .option("--public-body <id>", "filter by addressed public-body id", once(parseIdFilter))
    .option("--tags <tag>", "filter by one tag name, exact and case-sensitive", once(parseNonEmpty))
    .option("--reference <prefix>", "filter by reference (prefix match)", once(parseNonEmpty))
    .option("--slug <slug>", "filter by exact slug", once(parseNonEmpty))
    .option("--is-foi [bool]", "only genuine FOI requests (true/false)", onceValue)
    .option("--checked [bool]", "only moderator-checked requests (true/false)", onceValue)
    .option("--has-same [bool]", "only requests with identical copies (true/false)", onceValue)
    .option("--costs-min <eur>", "minimum charged costs in EUR", once(parseNonNegativeNumber))
    .option("--costs-max <eur>", "maximum charged costs in EUR", once(parseNonNegativeNumber))
    .option("--created-after <date>", "created on/after this date (YYYY-MM-DD)", once(parseNonEmpty))
    .option("--created-before <date>", "created on/before this date (YYYY-MM-DD)", once(parseNonEmpty))
    .option("--project <id>", "filter by project id", once(parseIdFilter))
    .option("--user <id>", "filter by requesting user id", once(parseIdFilter))
    .option("--follower <id>", "filter by follower user id", once(parseIdFilter));
}

/**
 * The note for an empty `request list`: `--categories`, `--classification` and `--tags`
 * match the exact name, case-sensitive, so `umwelt`, a slug or an id matches nothing
 * (Froide filters `public_body__categories__name`, `public_body__classification__name`,
 * `tags__name`) and the API can't tell that apart from a real "no requests".
 */
export function requestEmptyNote(opts: Record<string, unknown>): string | undefined {
  const named = [
    ["--categories", opts["categories"], 'the exact category name, e.g. "Umwelt" (category list --q)'],
    ["--classification", opts["classification"], 'the exact classification name, e.g. "Ministerium" (classification list --q)'],
    ["--tags", opts["tags"], "one exact tag name (request tags <text>)"],
  ].filter(([, value]) => typeof value === "string");
  if (named.length === 0) return undefined;
  const parts = named.map(([flag, value, hint]) => `${String(flag)} ${JSON.stringify(value)} takes ${String(hint)}`);
  return `Note: no request matched. Name filters match exactly and case-sensitively: ${parts.join("; ")}.`;
}

function buildRequestParams(opts: Record<string, unknown>): QueryParams {
  return pruneUndefined({
    status: opts["status"],
    resolution: opts["resolution"],
    jurisdiction: opts["jurisdiction"],
    law: opts["law"],
    categories: opts["categories"],
    classification: opts["classification"],
    campaign: opts["campaign"],
    public_body: opts["publicBody"],
    tags: opts["tags"],
    reference: opts["reference"],
    slug: opts["slug"],
    is_foi: asBool(opts["isFoi"]),
    checked: asBool(opts["checked"]),
    has_same: asBool(opts["hasSame"]),
    costs_min: opts["costsMin"],
    costs_max: opts["costsMax"],
    created_at_after: opts["createdAfter"],
    created_at_before: opts["createdBefore"],
    project: opts["project"],
    user: opts["user"],
    follower: opts["follower"],
  }) as QueryParams;
}

function buildSearchParams(opts: Record<string, unknown>): QueryParams {
  return pruneUndefined({
    q: opts["q"],
    jurisdiction: opts["jurisdiction"],
    category: opts["category"],
  }) as QueryParams;
}

export function registerRequestCommands(program: Command, deps: CliDeps): void {
  const requests = program
    .command("request")
    .description("FOI requests (Informationsfreiheitsanfragen) — the central resource");

  addList(requests, deps, {
    description: "List/filter public FOI requests",
    addFilters: addRequestFilters,
    buildParams: buildRequestParams,
    doList: (client, params) => client.requests.list(params),
    doListCsv: (client, params) => client.requests.listCsv(params),
    emptyNote: requestEmptyNote,
  });

  addGet(requests, deps, "Get one request by id (includes its message thread)", (client, id) =>
    client.requests.get(id),
  );

  // NOTE: the search endpoint also exposes a `status` filter, but its server-side
  // choice set rejects every value (all documented request statuses return HTTP
  // 400 "keine gültige Auswahl"), so it is deliberately not offered here — an
  // option where no value can ever succeed is worse than no option.
  const search = addPagination(
    requests
      .command("search")
      .description("Full-text search over public requests")
      .option("--q <text>", "full-text query", once(parseNonEmpty))
      .option("--jurisdiction <slug>", "restrict to a jurisdiction", once(parseNonEmpty))
      .option("--category <slug>", "restrict to a category", once(parseNonEmpty)),
  ).option("--csv", CSV_HELP);
  search.action(
    action(deps, async ({ client, global, opts }) => {
      const params: QueryParams = { ...buildSearchParams(opts), ...paginationParams(opts) };
      if (opts["csv"]) {
        renderCsvPage(deps, global, await client.requests.searchCsv(params), params);
      } else {
        renderJson(deps, global, await client.requests.search(params));
      }
    }),
  );

  addPagination(
    requests
      .command("tags")
      .argument("<query>", "tag name fragment to autocomplete (must be non-empty)", parseNonEmpty)
      .description("Autocomplete request tag names"),
  ).action(
    action(deps, async ({ client, global, opts }, [q]) => {
      renderJson(deps, global, await client.requests.tagsAutocomplete(q!, paginationParams(opts)));
    }),
  );
}
