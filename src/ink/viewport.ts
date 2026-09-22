import { useEffect, useState } from "react";
import { useStdout } from "ink";

// Size the dynamic viewport against the SAME output stream Ink renders to.
// Resize must trigger React too: Ink's Yoga relayout alone cannot repaginate text.
export function useTerminalSize(): { rows: number; columns: number } {
  const { stdout } = useStdout();
  const read = () => ({ rows: stdout.rows || 24, columns: stdout.columns || 80 });
  const [size, setSize] = useState(read);
  useEffect(() => {
    const resize = () => setSize(read());
    stdout.on("resize", resize);
    return () => { stdout.off("resize", resize); };
  }, [stdout]);
  return size;
}
