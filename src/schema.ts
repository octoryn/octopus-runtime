/**
 * Minimal, zero-dependency schema validation.
 *
 * The runtime depends on the {@link Schema} *interface*, not on any concrete
 * validation library. Action inputs are validated at the boundary so that a
 * malformed intent can never reach a connector's `render` or `execute`.
 *
 * A small built-in implementation is provided here so the core has no runtime
 * dependencies. Any object that satisfies `Schema<T>` — including a Zod schema
 * (`{ parse(v): T }`) — is accepted by the runtime, so this can be swapped out
 * without touching connector or engine code.
 */

import { ValidationError } from "./errors.js";

/** A validator that parses unknown input into a typed value, or throws. */
export interface Schema<T> {
  /** Parse and validate `value`, returning it typed as `T` or throwing {@link ValidationError}. */
  parse(value: unknown): T;
}

/** Infer the output type of a {@link Schema}. */
export type Infer<S> = S extends Schema<infer T> ? T : never;

/** Internal marker used to detect optional fields inside `object`. */
const OPTIONAL = Symbol("optional");

interface OptionalSchema<T> extends Schema<T | undefined> {
  readonly [OPTIONAL]: true;
}

function fail(path: string, message: string): never {
  const where = path === "" ? "value" : `\`${path}\``;
  throw new ValidationError(`${where} ${message}`, path);
}

/** A `string` schema. */
export function string(): Schema<string> {
  return {
    parse(value, path = "") {
      if (typeof value !== "string") fail(path as string, "must be a string");
      return value as string;
    },
  } as Schema<string>;
}

/** A finite `number` schema. */
export function number(): Schema<number> {
  return {
    parse(value, path = "") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        fail(path as string, "must be a finite number");
      }
      return value as number;
    },
  } as Schema<number>;
}

/** A `boolean` schema. */
export function boolean(): Schema<boolean> {
  return {
    parse(value, path = "") {
      if (typeof value !== "boolean") fail(path as string, "must be a boolean");
      return value as boolean;
    },
  } as Schema<boolean>;
}

/** A string constrained to a fixed set of literal values. */
export function enums<const T extends readonly string[]>(...values: T): Schema<T[number]> {
  return {
    parse(value, path = "") {
      if (typeof value !== "string" || !values.includes(value)) {
        fail(path as string, `must be one of: ${values.join(", ")}`);
      }
      return value as T[number];
    },
  } as Schema<T[number]>;
}

/** An array whose items each satisfy `item`. */
export function array<T>(item: Schema<T>): Schema<T[]> {
  return {
    parse(value, path = "") {
      if (!Array.isArray(value)) fail(path as string, "must be an array");
      return (value as unknown[]).map((entry, i) =>
        (item as SchemaWithPath<T>).parse(entry, joinPath(path as string, `[${i}]`)),
      );
    },
  } as Schema<T[]>;
}

/** Wrap a schema so that `undefined` is accepted (for optional object fields). */
export function optional<T>(inner: Schema<T>): Schema<T | undefined> {
  const schema: OptionalSchema<T> = {
    [OPTIONAL]: true,
    parse(value, path = "") {
      if (value === undefined) return undefined;
      return (inner as SchemaWithPath<T>).parse(value, path as string);
    },
  } as OptionalSchema<T>;
  return schema;
}

type Shape = Record<string, Schema<unknown>>;

type ObjectOutput<S extends Shape> = {
  [K in keyof S]: Infer<S[K]>;
};

/** An object with the given field schemas. Unknown keys are dropped. */
export function object<S extends Shape>(shape: S): Schema<ObjectOutput<S>> {
  return {
    parse(value, path = "") {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        fail(path as string, "must be an object");
      }
      const source = value as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(shape)) {
        const fieldSchema = shape[key] as SchemaWithPath<unknown>;
        const fieldPath = joinPath(path as string, key);
        const parsed = fieldSchema.parse(source[key], fieldPath);
        if (parsed !== undefined) result[key] = parsed;
      }
      return result as ObjectOutput<S>;
    },
  } as Schema<ObjectOutput<S>>;
}

/**
 * A pass-through schema that accepts any value.
 * Use only when input genuinely has no shape (e.g. opaque provider payloads).
 */
export function unknownValue(): Schema<unknown> {
  return { parse: (value) => value };
}

// --- internal path-threading helpers -------------------------------------
// Built-in schemas accept an optional second `path` argument so nested errors
// report a useful location. The public `Schema<T>` interface intentionally
// hides this, so external validators (e.g. Zod) remain compatible.

interface SchemaWithPath<T> {
  parse(value: unknown, path?: string): T;
}

function joinPath(base: string, segment: string): string {
  if (base === "") return segment;
  return segment.startsWith("[") ? `${base}${segment}` : `${base}.${segment}`;
}
