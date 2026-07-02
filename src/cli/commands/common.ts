// Helpers shared by the resource command groups. Every resource exposes the same
// two shapes — a paginated `list` (optionally as CSV) and a `get <id>` detail —
// so we build them from a small spec instead of repeating the wiring ten times.

import { Command } from "commander";
import type { CliDeps } from "../io.js";
import type { FragDenStaatClient } from "../../client/client.js";
import type { RawResponse } from "../../client/engine.js";
import type { QueryParams } from "../../client/query.js";
import {
  action,
  addPagination,
  paginationParams,
  parseNonEmpty,
  renderJson,
  renderRaw,
} from "../shared.js";
import { FdsError } from "../../client/errors.js";

type Client = FragDenStaatClient;

/**
 * Coerce a commander boolean option to a boolean. The options are declared with an
 * optional argument (`--flag` alone, or `--flag true|false`), so commander accepts
 * any string. Return `undefined` only when the option was not supplied; reject any
 * other value rather than silently dropping the filter (which would return a
 * misleadingly *unfiltered* result set).
 */
export function asBool(value: unknown): boolean | undefined {
  if (value === undefined) return undefined; // option not supplied
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  throw new FdsError(`Expected "true" or "false", got "${String(value)}".`);
}

export interface ListSpec {
  /** Sub-command description. */
  description: string;
  /** Add resource-specific filter options to the `list` command. */
  addFilters?: (cmd: Command) => Command;
  /** Build the resource filter params (excluding offset/limit) from parsed opts. */
  buildParams?: (opts: Record<string, unknown>) => QueryParams;
  /** Fetch the JSON list envelope. */
  doList: (client: Client, params: QueryParams) => Promise<unknown>;
  /** Fetch the list as CSV. When provided, a `--csv` flag is added. */
  doListCsv?: (client: Client, params: QueryParams) => Promise<RawResponse>;
}

/** Register a `list` sub-command (pagination + optional filters + optional CSV). */
export function addList(parent: Command, deps: CliDeps, spec: ListSpec): Command {
  let cmd = parent.command("list").description(spec.description);
  if (spec.addFilters) cmd = spec.addFilters(cmd);
  cmd = addPagination(cmd);
  if (spec.doListCsv) {
    cmd = cmd.option("--csv", "output the server-rendered CSV export instead of JSON");
  }
  cmd.action(
    action(deps, async ({ client, global, opts }) => {
      const params: QueryParams = {
        ...(spec.buildParams ? spec.buildParams(opts) : {}),
        ...paginationParams(opts),
      };
      if (opts["csv"] && spec.doListCsv) {
        renderRaw(deps, global, await spec.doListCsv(client, params));
      } else {
        renderJson(deps, global, await spec.doList(client, params));
      }
    }),
  );
  return cmd;
}

/** Register a `get <id>` detail sub-command. */
export function addGet(
  parent: Command,
  deps: CliDeps,
  description: string,
  doGet: (client: Client, id: string) => Promise<unknown>,
): Command {
  return parent
    .command("get <id>")
    .description(description)
    .action(
      action(deps, async ({ client, global }, [id]) => {
        renderJson(deps, global, await doGet(client, id!));
      }),
    );
}

/** Register an `autocomplete <query>` sub-command. */
export function addAutocomplete(
  parent: Command,
  deps: CliDeps,
  description: string,
  doAuto: (client: Client, q: string) => Promise<unknown>,
): Command {
  return parent
    .command("autocomplete")
    .argument("<query>", "text to autocomplete (must be non-empty)", parseNonEmpty)
    .description(description)
    .action(
      action(deps, async ({ client, global }, [q]) => {
        renderJson(deps, global, await doAuto(client, q!));
      }),
    );
}
