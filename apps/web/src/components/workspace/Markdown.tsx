/**
 * Shared markdown renderer for problem statements, hint text, and editorials — all of which are
 * LLM-generated (docs/CONTRACTS.md §12). `react-markdown` does not parse embedded raw HTML by
 * default (no `rehype-raw`), and `rehype-sanitize` strips anything that slips through anyway, so
 * a statement containing `<script>` or `onerror=` renders as inert text, never executes.
 * `rehype-highlight` adds syntax highlighting to fenced code blocks; the sanitize schema is
 * extended to keep the `className` it adds on `code`/`span`.
 */
import ReactMarkdown from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkGfm from "remark-gfm";

const schema = {
  ...defaultSchema,
  attributes: {
    ...defaultSchema.attributes,
    code: [...(defaultSchema.attributes?.code ?? []), "className"],
    span: [...(defaultSchema.attributes?.span ?? []), "className"],
  },
};

export function Markdown({ children, className = "" }: { children: string; className?: string }) {
  return (
    <div className={`markdown-body text-sm leading-relaxed text-text ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeSanitize, schema], rehypeHighlight]}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
