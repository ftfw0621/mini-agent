// marked-terminal v7 ships no type declarations and @types/marked-terminal
// only covers v6 (a different export shape). A minimal local ambient decl keeps
// us self-contained — we only use the `markedTerminal` factory as a marked plugin.
declare module "marked-terminal" {
  import type { MarkedExtension } from "marked";
  /** Build a marked extension that renders tokens to ANSI terminal output. */
  export function markedTerminal(options?: Record<string, unknown>, highlightOptions?: Record<string, unknown>): MarkedExtension;
}
