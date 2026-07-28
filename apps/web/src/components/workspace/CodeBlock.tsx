/**
 * A fenced Python code block, routed through the shared `Markdown` renderer so submitted source
 * and reference solutions get the same sanitize + highlight path as every other code block on the
 * page.
 *
 * Trailing whitespace is trimmed. An editor buffer almost always ends in one or more newlines, and
 * a code fence reproduces them faithfully — which renders as a tall empty box under two lines of
 * code. Leading indentation is untouched: that belongs to the code.
 */
import { Markdown } from "./Markdown";

export function CodeBlock({ code }: { code: string }) {
  const trimmed = code.replace(/\s+$/, "");
  return <Markdown>{`\`\`\`python\n${trimmed}\n\`\`\``}</Markdown>;
}
