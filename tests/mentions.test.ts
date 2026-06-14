import fs from "node:fs"; // create files to mention
import os from "node:os"; // scratch dir
import path from "node:path"; // join scratch paths
import { findMentions, expandMentions } from "../src/mentions.js"; // unit under test
import { check, checkContains, finish } from "./helpers.js"; // assertions

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mini-agent-mentions-"));
const file = path.join(dir, "cart.js");
fs.writeFileSync(file, "function total() { return 42; }\n");

// ---- findMentions: parsing -------------------------------------------------------------
check("finds a leading mention", JSON.stringify(findMentions("@foo.ts explain it")) === JSON.stringify(["foo.ts"]));
check("finds a mention after whitespace", JSON.stringify(findMentions("look at @a/b.ts please")) === JSON.stringify(["a/b.ts"]));
check("two mentions", findMentions("@one and @two").length === 2);
check("an email is NOT a mention (@ mid-word)", findMentions("mail me at bob@example.com").length === 0);
check("trailing punctuation is stripped", JSON.stringify(findMentions("see @cart.js.")) === JSON.stringify(["cart.js"]));
check("a bare line has no mentions", findMentions("no references here").length === 0);

// ---- expandMentions: attaches a real file ----------------------------------------------
{
  const { augmented, mentions } = expandMentions(`explain @${file}`);
  check("the file resolves ok", mentions[0]?.status === "ok");
  checkContains("the message gets a referenced-files block", augmented, "[Referenced files");
  checkContains("the file's content is attached", augmented, "return 42");
  checkContains("the attachment is labeled with the path", augmented, file);
}

// ---- a line with no resolvable mention is unchanged -------------------------------------
{
  const { augmented } = expandMentions("just a normal question");
  check("no mentions → line unchanged", augmented === "just a normal question");
}
{
  // @something that isn't a file (no such path) is ignored silently, not attached.
  const { augmented, mentions } = expandMentions("ping @nonsense-not-a-file");
  check("a non-file mention is marked missing", mentions[0]?.status === "missing");
  check("a missing mention does not alter the line", augmented === "ping @nonsense-not-a-file");
}

// ---- a secret file is REFUSED, never read ----------------------------------------------
{
  const secret = path.join(dir, ".env"); // matches the secret-file rule
  fs.writeFileSync(secret, "API_KEY=supersecret\n");
  const { augmented, mentions } = expandMentions(`use @${secret}`);
  check("the secret file is denied by the gate", mentions[0]?.status === "denied");
  check("the secret value never enters the message", !augmented.includes("supersecret"));
  checkContains("the refusal is shown instead", augmented, "refused: secret file");
}

// ---- a directory mention is not attached -----------------------------------------------
check("a directory resolves as dir, not ok", expandMentions(`@${dir}`).mentions[0]?.status === "dir");

fs.rmSync(dir, { recursive: true, force: true });
finish();
