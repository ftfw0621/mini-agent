import { validateArgs, type ParamSchema } from "../src/validate.js"; // unit under test
import { dispatch } from "../src/tools.js"; // verify it's wired into dispatch
import { check, checkContains, finish } from "./helpers.js"; // assertions

// A schema like our tools declare: typed properties + a required list.
const schema: ParamSchema = {
  type: "object",
  properties: { path: { type: "string" }, count: { type: "number" }, deep: { type: "boolean" } },
  required: ["path"],
};

const ok = (problems: string[]) => problems.length === 0;

// ---- valid input passes ----------------------------------------------------------------
check("all good → no problems", ok(validateArgs(schema, { path: "a.txt" })));
check("optional params may be omitted", ok(validateArgs(schema, { path: "a.txt" })));
check("present optional of right type passes", ok(validateArgs(schema, { path: "a.txt", count: 3, deep: true })));

// ---- required-field checks --------------------------------------------------------------
checkContains("missing required is reported", validateArgs(schema, { count: 3 }).join(), 'missing required parameter "path"');
checkContains("null counts as missing", validateArgs(schema, { path: null }).join(), 'missing required parameter "path"');

// ---- type checks ------------------------------------------------------------------------
checkContains("wrong type reported (number as string)", validateArgs(schema, { path: "a", count: "3" }).join(), 'parameter "count" should be number');
checkContains("array where boolean expected", validateArgs(schema, { path: "a", deep: [1, 2] }).join(), "should be boolean, got array");
check("integer type accepts whole numbers", ok(validateArgs({ properties: { n: { type: "integer" } } }, { n: 5 })));
check("integer type rejects floats", validateArgs({ properties: { n: { type: "integer" } } }, { n: 5.5 }).length === 1);

// ---- shape checks -----------------------------------------------------------------------
checkContains("non-object args rejected", validateArgs(schema, "just a string").join(), "must be a JSON object");
checkContains("array args rejected", validateArgs(schema, ["a"]).join(), "must be a JSON object");
check("no schema → anything passes", ok(validateArgs(undefined, { whatever: 1 })));
check("undeclared types are not over-constrained", ok(validateArgs({ properties: { x: {} }, required: ["x"] }, { x: { nested: true } })));

// ---- wired into dispatch: the model gets a precise, actionable message -------------------
const missing = await dispatch("read_file", JSON.stringify({})); // read_file requires "path"
checkContains("dispatch validates required", missing, 'missing required parameter "path"');
checkContains("dispatch tells the model to fix and retry", missing, "Fix and call again");
const wrongType = await dispatch("search", JSON.stringify({ pattern: 123 })); // pattern must be string
checkContains("dispatch validates types", wrongType, 'parameter "pattern" should be string');

finish();
