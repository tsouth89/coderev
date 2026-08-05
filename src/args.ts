/**
 * Argument parsing on top of `node:util` parseArgs.
 *
 * parseArgs handles the tokenising; this adds the two things it does not: a
 * usage string, and turning a missing required flag into a readable message
 * rather than a stack trace.
 */
import { parseArgs, type ParseArgsConfig } from "node:util";

// Declared as a field rather than a constructor parameter property, which
// cannot be type-stripped and so would break running these files directly.
export class UsageError extends Error {
  readonly usage: string;

  constructor(message: string, usage: string) {
    super(message);
    this.name = "UsageError";
    this.usage = usage;
  }
}

export type ArgValues = Record<string, string | boolean | Array<string> | undefined>;

export function parse<T extends NonNullable<ParseArgsConfig["options"]>>(input: {
  readonly argv: ReadonlyArray<string>;
  readonly options: T;
  readonly usage: string;
}): { values: ArgValues; help: boolean } {
  try {
    const { values } = parseArgs({
      args: [...input.argv],
      options: { ...input.options, help: { type: "boolean", short: "h" } },
      allowPositionals: false,
    });
    const parsed = values as ArgValues;
    return { values: parsed, help: parsed.help === true };
  } catch (cause) {
    throw new UsageError(cause instanceof Error ? cause.message : String(cause), input.usage);
  }
}

export function requireString(
  values: Record<string, unknown>,
  name: string,
  usage: string,
): string {
  const value = values[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new UsageError(`--${name} is required`, usage);
  }
  return value.trim();
}

/**
 * Report a failure and pick an exit code.
 *
 * Usage errors exit 2 so a workflow can tell "you invoked this wrong" apart
 * from "the review ran and something went wrong", which otherwise look
 * identical to anything reading exit codes.
 */
export function reportFailure(cause: unknown): number {
  if (cause instanceof UsageError) {
    console.error(`Error: ${cause.message}\n\n${cause.usage}`);
    return 2;
  }
  console.error(`Error: ${cause instanceof Error ? cause.message : String(cause)}`);
  return 1;
}
