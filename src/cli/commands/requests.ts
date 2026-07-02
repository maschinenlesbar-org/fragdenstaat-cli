import { Command } from "commander";
import type { CliDeps } from "../io.js";
import {
  action,
  addPagination,
  choiceOption,
  paginationParams,
  pruneUndefined,
  renderJson,
  renderRaw,
} from "../shared.js";
import { addList, addGet, asBool } from "./common.js";
import type { QueryParams } from "../../client/query.js";
import { RequestStatusValues, RequestResolutionValues } from "../../client/enums.js";

function addRequestFilters(cmd: Command): Command {
  return cmd
    .addOption(choiceOption("--status <status>", "filter by lifecycle status", RequestStatusValues))
    .addOption(
      choiceOption("--resolution <resolution>", "filter by outcome (resolved requests)", RequestResolutionValues),
    )
    .option("--jurisdiction <id>", "filter by jurisdiction id")
    .option("--law <id>", "filter by FOI law id")
    .option("--categories <id>", "filter by category id")
    .option("--classification <id>", "filter by public-body classification id")
    .option("--campaign <id>", "filter by campaign id")
    .option("--public-body <id>", "filter by addressed public-body id")
    .option("--tags <tag>", "filter by tag name")
    .option("--reference <prefix>", "filter by reference (prefix match)")
    .option("--slug <slug>", "filter by exact slug")
    .option("--is-foi [bool]", "only genuine FOI requests (true/false)")
    .option("--checked [bool]", "only moderator-checked requests (true/false)")
    .option("--has-same [bool]", "only requests with identical copies (true/false)")
    .option("--costs-min <eur>", "minimum charged costs in EUR")
    .option("--costs-max <eur>", "maximum charged costs in EUR")
    .option("--created-after <date>", "created on/after this date (YYYY-MM-DD)")
    .option("--created-before <date>", "created on/before this date (YYYY-MM-DD)")
    .option("--project <id>", "filter by project id")
    .option("--user <id>", "filter by requesting user id")
    .option("--follower <id>", "filter by follower user id");
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
      .option("--q <text>", "full-text query")
      .option("--jurisdiction <slug>", "restrict to a jurisdiction")
      .option("--category <slug>", "restrict to a category"),
  ).option("--csv", "output the server-rendered CSV export instead of JSON");
  search.action(
    action(deps, async ({ client, global, opts }) => {
      const params: QueryParams = { ...buildSearchParams(opts), ...paginationParams(opts) };
      if (opts["csv"]) {
        renderRaw(deps, global, await client.requests.searchCsv(params));
      } else {
        renderJson(deps, global, await client.requests.search(params));
      }
    }),
  );

  requests
    .command("tags <query>")
    .description("Autocomplete request tag names")
    .action(
      action(deps, async ({ client, global }, [q]) => {
        renderJson(deps, global, await client.requests.tagsAutocomplete(q!));
      }),
    );
}
