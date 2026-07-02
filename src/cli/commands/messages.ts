import { Command } from "commander";
import type { CliDeps } from "../io.js";
import { choiceOption, pruneUndefined } from "../shared.js";
import { addList, addGet, asBool } from "./common.js";
import type { QueryParams } from "../../client/query.js";
import { MessageKindValues } from "../../client/enums.js";

function addMessageFilters(cmd: Command): Command {
  return cmd
    .option("--request <id>", "filter to one request's correspondence")
    .addOption(choiceOption("--kind <kind>", "filter by transport (email, post, fax, ...)", MessageKindValues))
    .option("--is-response [bool]", "only replies from the authority (true/false)");
}

function buildMessageParams(opts: Record<string, unknown>): QueryParams {
  return pruneUndefined({
    request: opts["request"],
    kind: opts["kind"],
    is_response: asBool(opts["isResponse"]),
  }) as QueryParams;
}

export function registerMessageCommands(program: Command, deps: CliDeps): void {
  const message = program
    .command("message")
    .description("Messages (Nachrichten) in the correspondence of FOI requests");

  addList(message, deps, {
    description: "List/filter messages (use --request to scope to one request)",
    addFilters: addMessageFilters,
    buildParams: buildMessageParams,
    doList: (client, params) => client.messages.list(params),
    doListCsv: (client, params) => client.messages.listCsv(params),
  });

  addGet(message, deps, "Get one message by id", (client, id) => client.messages.get(id));
}
