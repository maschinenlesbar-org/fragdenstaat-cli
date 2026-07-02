import { Command } from "commander";
import type { CliDeps } from "../io.js";
import { pruneUndefined } from "../shared.js";
import { addList, addGet, addAutocomplete, asBool } from "./common.js";
import type { QueryParams } from "../../client/query.js";

function addLawFilters(cmd: Command): Command {
  return cmd
    .option("--q <text>", "full-text query over name/description")
    .option("--jurisdiction <id>", "filter by jurisdiction id")
    .option("--mediator <id>", "filter by mediator public-body id")
    .option("--meta [bool]", "only meta-laws (combinations) — true/false")
    .option("--id <id>", "filter by law id");
}

function buildLawParams(opts: Record<string, unknown>): QueryParams {
  return pruneUndefined({
    q: opts["q"],
    jurisdiction: opts["jurisdiction"],
    mediator: opts["mediator"],
    meta: asBool(opts["meta"]),
    id: opts["id"],
  }) as QueryParams;
}

export function registerLawCommands(program: Command, deps: CliDeps): void {
  const law = program
    .command("law")
    .description("FOI laws (IFG, UIG, VIG, state transparency acts, local statutes)");

  addList(law, deps, {
    description: "List/filter FOI laws",
    addFilters: addLawFilters,
    buildParams: buildLawParams,
    doList: (client, params) => client.laws.list(params),
    doListCsv: (client, params) => client.laws.listCsv(params),
  });

  addGet(law, deps, "Get one law by id", (client, id) => client.laws.get(id));

  addAutocomplete(law, deps, "Autocomplete law names", (client, q) => client.laws.autocomplete(q));
}
