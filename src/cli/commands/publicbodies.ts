import { Command } from "commander";
import type { CliDeps } from "../io.js";
import {
  action,
  addPagination,
  paginationParams,
  pruneUndefined,
  renderJson,
  renderRaw,
} from "../shared.js";
import { addList, addGet, addAutocomplete } from "./common.js";
import type { QueryParams } from "../../client/query.js";

function addPublicBodyFilters(cmd: Command): Command {
  return cmd
    .option("--q <text>", "full-text query over name/description")
    .option("--jurisdiction <id>", "filter by jurisdiction id")
    .option("--classification <id>", "filter by classification id (subtree match)")
    .option("--classification-id <id>", "filter by exact classification id")
    .option("--category <id>", "filter by category id")
    .option("--regions <id>", "filter by geo-region id")
    .option("--slug <slug>", "filter by exact slug")
    .option("--lnglat <lng,lat>", "sort/limit by proximity to a lng,lat point");
}

function buildPublicBodyParams(opts: Record<string, unknown>): QueryParams {
  return pruneUndefined({
    q: opts["q"],
    jurisdiction: opts["jurisdiction"],
    classification: opts["classification"],
    classification_id: opts["classificationId"],
    category: opts["category"],
    regions: opts["regions"],
    slug: opts["slug"],
    lnglat: opts["lnglat"],
  }) as QueryParams;
}

export function registerPublicBodyCommands(program: Command, deps: CliDeps): void {
  const pb = program
    .command("publicbody")
    .description("Public bodies / authorities (Behörden) that receive FOI requests");

  addList(pb, deps, {
    description: "List/filter public bodies",
    addFilters: addPublicBodyFilters,
    buildParams: buildPublicBodyParams,
    doList: (client, params) => client.publicBodies.list(params),
    doListCsv: (client, params) => client.publicBodies.listCsv(params),
  });

  addGet(pb, deps, "Get one public body by id", (client, id) => client.publicBodies.get(id));

  const search = addPagination(
    pb
      .command("search")
      .description("Full-text search over public bodies")
      .option("--q <text>", "full-text query")
      .option("--jurisdiction <id>", "restrict to a jurisdiction id")
      .option("--classification <id>", "restrict to a classification id")
      .option("--category <id>", "restrict to a category id"),
  ).option("--csv", "output the server-rendered CSV export instead of JSON");
  search.action(
    action(deps, async ({ client, global, opts }) => {
      const params: QueryParams = { ...buildPublicBodyParams(opts), ...paginationParams(opts) };
      if (opts["csv"]) {
        renderRaw(deps, global, await client.publicBodies.searchCsv(params));
      } else {
        renderJson(deps, global, await client.publicBodies.search(params));
      }
    }),
  );

  addAutocomplete(pb, deps, "Autocomplete public-body names", (client, q) =>
    client.publicBodies.autocomplete(q),
  );
}
