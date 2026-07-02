// Reference-data / taxonomy resources: jurisdictions, categories, classifications,
// campaigns and geo-regions. Grouped together because they share the same simple
// list/get shape (a couple add filters or autocomplete).

import { Command } from "commander";
import type { CliDeps } from "../io.js";
import { choiceOption, pruneUndefined } from "../shared.js";
import { addList, addGet, addAutocomplete, asBool } from "./common.js";
import type { QueryParams } from "../../client/query.js";
import { GeoRegionKindValues } from "../../client/enums.js";

function buildCategoryParams(opts: Record<string, unknown>): QueryParams {
  return pruneUndefined({
    q: opts["q"],
    name: opts["name"],
    parent: opts["parent"],
    ancestor: opts["ancestor"],
    depth: opts["depth"],
    is_topic: asBool(opts["isTopic"]),
  }) as QueryParams;
}

function buildClassificationParams(opts: Record<string, unknown>): QueryParams {
  return pruneUndefined({
    q: opts["q"],
    name: opts["name"],
    parent: opts["parent"],
    ancestor: opts["ancestor"],
    depth: opts["depth"],
  }) as QueryParams;
}

function buildGeoRegionParams(opts: Record<string, unknown>): QueryParams {
  return pruneUndefined({
    q: opts["q"],
    name: opts["name"],
    kind: opts["kind"],
    kind_detail: opts["kindDetail"],
    level: opts["level"],
    region_identifier: opts["regionIdentifier"],
    slug: opts["slug"],
    ancestor: opts["ancestor"],
    id: opts["id"],
    latlng: opts["latlng"],
  }) as QueryParams;
}

export function registerReferenceCommands(program: Command, deps: CliDeps): void {
  // Jurisdictions — Bund, the 16 Länder, the EU (18 total). List + get only.
  const jur = program
    .command("jurisdiction")
    .description("Jurisdictions (Bund, the 16 Länder, the EU)");
  addList(jur, deps, {
    description: "List jurisdictions",
    doList: (client, params) => client.jurisdictions.list(params),
    doListCsv: (client, params) => client.jurisdictions.listCsv(params),
  });
  addGet(jur, deps, "Get one jurisdiction by id", (client, id) => client.jurisdictions.get(id));

  // Categories — topical taxonomy (a tree). List (+ filters) + get + autocomplete.
  const cat = program.command("category").description("Topical categories (Themen) — a tree");
  addList(cat, deps, {
    description: "List/filter categories",
    addFilters: (cmd) =>
      cmd
        .option("--q <text>", "full-text query")
        .option("--name <name>", "filter by exact name")
        .option("--parent <id>", "filter to direct children of this category id")
        .option("--ancestor <id>", "filter to all descendants of this category id")
        .option("--depth <n>", "filter by tree depth")
        .option("--is-topic [bool]", "only topic categories (true/false)"),
    buildParams: buildCategoryParams,
    doList: (client, params) => client.categories.list(params),
    doListCsv: (client, params) => client.categories.listCsv(params),
  });
  addGet(cat, deps, "Get one category by id", (client, id) => client.categories.get(id));
  addAutocomplete(cat, deps, "Autocomplete category names", (client, q) =>
    client.categories.autocomplete(q),
  );

  // Classifications — the type/kind of public body (a tree). List (+ filters) + get.
  const cls = program
    .command("classification")
    .description("Public-body classifications (Behördentypen) — a tree");
  addList(cls, deps, {
    description: "List/filter classifications",
    addFilters: (cmd) =>
      cmd
        .option("--q <text>", "full-text query")
        .option("--name <name>", "filter by exact name")
        .option("--parent <id>", "filter to direct children of this classification id")
        .option("--ancestor <id>", "filter to all descendants of this classification id")
        .option("--depth <n>", "filter by tree depth"),
    buildParams: buildClassificationParams,
    doList: (client, params) => client.classifications.list(params),
    doListCsv: (client, params) => client.classifications.listCsv(params),
  });
  addGet(cls, deps, "Get one classification by id", (client, id) =>
    client.classifications.get(id),
  );

  // Campaigns — coordinated mass-request projects. List + get only.
  const camp = program
    .command("campaign")
    .description("Campaigns (Kampagnen) — coordinated mass-request projects");
  addList(camp, deps, {
    description: "List campaigns",
    doList: (client, params) => client.campaigns.list(params),
    doListCsv: (client, params) => client.campaigns.listCsv(params),
  });
  addGet(camp, deps, "Get one campaign by id", (client, id) => client.campaigns.get(id));

  // Geo-regions — countries, states, districts, municipalities, zip codes.
  const geo = program
    .command("georegion")
    .description("Geographic regions (Regionen): states, districts, municipalities, zip codes");
  addList(geo, deps, {
    description: "List/filter geo-regions",
    addFilters: (cmd) =>
      cmd
        .option("--q <text>", "full-text query")
        .option("--name <name>", "filter by exact name")
        .addOption(choiceOption("--kind <kind>", "filter by region kind", GeoRegionKindValues))
        .option("--kind-detail <text>", "filter by kind detail label")
        .option("--level <n>", "filter by hierarchy level")
        .option("--region-identifier <id>", "filter by region identifier")
        .option("--slug <slug>", "filter by exact slug")
        .option("--ancestor <id>", "filter to descendants of this region id")
        .option("--id <id>", "filter by region id")
        .option("--latlng <lat,lng>", "point-in-region lookup for a lat,lng point"),
    buildParams: buildGeoRegionParams,
    doList: (client, params) => client.georegions.list(params),
    doListCsv: (client, params) => client.georegions.listCsv(params),
  });
  addGet(geo, deps, "Get one geo-region by id (includes geometry)", (client, id) =>
    client.georegions.get(id),
  );
  addAutocomplete(geo, deps, "Autocomplete geo-region names", (client, q) =>
    client.georegions.autocomplete(q),
  );
}
