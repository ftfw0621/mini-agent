// Structured tool-call validation. A model's tool arguments are probabilistic
// output: it will sometimes drop a required field, send a number as a string,
// or pass the wrong shape. The harness job is to constrain that output to the
// declared schema and, on mismatch, hand back a PRECISE repair instruction so
// the model fixes it on the next turn — instead of the tool crashing or doing
// the wrong thing silently.
//
// This is a deliberately small subset of JSON Schema — exactly what our tool
// definitions (and MCP servers') actually use: an object with typed properties
// and a `required` list. Not a general validator; just enough to catch the
// mistakes models really make, with messages they can act on.

// The shape of a tool's `parameters` schema (the bits we check).
export interface ParamSchema {
  type?: string; // expected to be "object" at the top level
  properties?: Record<string, { type?: string; description?: string }>; // declared params
  required?: string[]; // which params must be present
}

// JSON Schema "type" → does this runtime value match it? Unknown/absent type
// matches anything (we don't over-constrain what the schema didn't constrain).
function typeMatches(value: unknown, type: string | undefined): boolean {
  switch (type) {
    case undefined:
      return true; // no declared type → anything goes
    case "string":
      return typeof value === "string";
    case "number":
    case "integer":
      return typeof value === "number" && (type === "number" || Number.isInteger(value));
    case "boolean":
      return typeof value === "boolean";
    case "array":
      return Array.isArray(value);
    case "object":
      return typeof value === "object" && value !== null && !Array.isArray(value);
    default:
      return true; // a type we don't model — don't reject on it
  }
}

// Validate parsed arguments against a schema. Returns a list of human-readable
// problems; an empty list means the arguments are valid. Pure — no I/O.
export function validateArgs(schema: ParamSchema | undefined, args: unknown): string[] {
  if (!schema) return []; // no schema → nothing to check
  const problems: string[] = [];

  // The arguments must be a plain object — every tool takes a named-arg object.
  if (typeof args !== "object" || args === null || Array.isArray(args)) {
    return ["arguments must be a JSON object of named parameters"];
  }
  const obj = args as Record<string, unknown>;

  // Every required parameter must be present and not null/undefined.
  for (const name of schema.required ?? []) {
    if (obj[name] === undefined || obj[name] === null) {
      problems.push(`missing required parameter "${name}"`);
    }
  }

  // Every PRESENT parameter that has a declared type must match it. (We only
  // type-check what was provided — absence is the `required` check's job.)
  for (const [name, spec] of Object.entries(schema.properties ?? {})) {
    if (obj[name] === undefined || obj[name] === null) continue; // not provided — skip (required handled above)
    if (!typeMatches(obj[name], spec.type)) {
      problems.push(`parameter "${name}" should be ${spec.type}, got ${Array.isArray(obj[name]) ? "array" : typeof obj[name]}`);
    }
  }

  return problems;
}
