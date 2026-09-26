import { Command } from "commander";
import type { CliDeps } from "../io.js";
import {
  action,
  addPagination,
  paginationParams,
  parseNonEmpty,
  parsePoint,
  pruneUndefined,
  renderCsvPage,
  renderJson,
} from "../shared.js";
import { CSV_HELP, addList, addGet, addAutocomplete } from "./common.js";
import type { QueryParams } from "../../client/query.js";

function addPublicBodyFilters(cmd: Command): Command {
  return cmd
    .option("--q <text>", "full-text query over name/description", parseNonEmpty)
    .option("--jurisdiction <id>", "filter by jurisdiction id", parseNonEmpty)
    .option("--classification <id>", "filter by classification id (subtree match)", parseNonEmpty)
    .option("--classification-id <id>", "filter by exact classification id", parseNonEmpty)
    .option("--category <id>", "filter by category id", parseNonEmpty)
    .option("--regions <id>", "filter by geo-region id", parseNonEmpty)
    .option("--slug <slug>", "filter by exact slug", parseNonEmpty)
    .option(
      "--lnglat <lng,lat>",
      "filter to bodies whose regions contain a lng,lat point (not sorted by distance)",
      parsePoint("lng,lat"),
    );
}

/**
 * Filters for `publicbody search`. The search endpoint reads the category as the
 * plural `categories` and silently ignores the singular `category` that `publicbody
 * list` uses, so the same `--category` flag maps to a different key here.
 */
function buildPublicBodySearchParams(opts: Record<string, unknown>): QueryParams {
  return pruneUndefined({
    q: opts["q"],
    jurisdiction: opts["jurisdiction"],
    classification: opts["classification"],
    categories: opts["category"],
  }) as QueryParams;
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
      .option("--q <text>", "full-text query", parseNonEmpty)
      .option("--jurisdiction <id>", "restrict to a jurisdiction id", parseNonEmpty)
      .option("--classification <id>", "restrict to a classification id", parseNonEmpty)
      .option("--category <id>", "restrict to a category id", parseNonEmpty),
  ).option("--csv", CSV_HELP);
  search.action(
    action(deps, async ({ client, global, opts }) => {
      const params: QueryParams = { ...buildPublicBodySearchParams(opts), ...paginationParams(opts) };
      if (opts["csv"]) {
        renderCsvPage(deps, global, await client.publicBodies.searchCsv(params), params);
      } else {
        renderJson(deps, global, await client.publicBodies.search(params));
      }
    }),
  );

  addAutocomplete(pb, deps, "Autocomplete public-body names", (client, q) =>
    client.publicBodies.autocomplete(q),
  );
}
