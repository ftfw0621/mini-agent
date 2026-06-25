import { launchInk } from "./launch.js"; // the reusable launcher (shared with agent.ts)

// Direct entry for the Ink REPL: npm run ink. agent.ts launches the same thing
// for a normal `mini-agent` interactive session.
await launchInk({ resume: process.argv.includes("-r") || process.argv.includes("--resume") });
