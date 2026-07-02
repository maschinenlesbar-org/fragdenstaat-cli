import { Command } from "commander";
import type { CliDeps } from "../io.js";
import { pruneUndefined } from "../shared.js";
import { addList, addGet } from "./common.js";
import type { QueryParams } from "../../client/query.js";

function addDocumentFilters(cmd: Command): Command {
  return cmd
    .option("--publicbody <id>", "filter by publishing public-body id")
    .option("--foirequest <id>", "filter by source request id")
    .option("--collection <id>", "filter by document-collection id")
    .option("--portal <id>", "filter by document-portal id")
    .option("--directory <id>", "filter by directory id")
    .option("--tag <id>", "filter by tag id (numeric)")
    .option("--ids <ids>", "filter by a comma-separated list of document ids")
    .option("--created-after <date>", "created on/after this date (YYYY-MM-DD)")
    .option("--created-before <date>", "created on/before this date (YYYY-MM-DD)");
}

function buildDocumentParams(opts: Record<string, unknown>): QueryParams {
  return pruneUndefined({
    publicbody: opts["publicbody"],
    foirequest: opts["foirequest"],
    collection: opts["collection"],
    portal: opts["portal"],
    directory: opts["directory"],
    tag: opts["tag"],
    ids: opts["ids"],
    created_at_after: opts["createdAfter"],
    created_at_before: opts["createdBefore"],
  }) as QueryParams;
}

export function registerDocumentCommands(program: Command, deps: CliDeps): void {
  const document = program
    .command("document")
    .description("Published documents (Dokumente) extracted from FOI responses");

  addList(document, deps, {
    description: "List/filter published documents",
    addFilters: addDocumentFilters,
    buildParams: buildDocumentParams,
    doList: (client, params) => client.documents.list(params),
    doListCsv: (client, params) => client.documents.listCsv(params),
  });

  addGet(document, deps, "Get one document by id (includes its pages)", (client, id) =>
    client.documents.get(id),
  );
}
