import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * Renders a legal Markdown document (Privacy Policy / Terms of Use) as a styled
 * page. The Markdown source lives in `docs/legal/*.md` and is imported raw, so
 * the published page and the repo document are always the same single source.
 * (No Tailwind typography plugin here, so element styles are set explicitly.)
 */
export default function LegalDoc({ content }: { content: string }) {
  return (
    <div className="mx-auto max-w-3xl px-4 py-10 sm:py-14">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="text-3xl font-bold tracking-tight mb-2">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-xl font-semibold tracking-tight mt-8 mb-2 pt-2 border-t border-border/60 first:border-0 first:pt-0">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-base font-semibold mt-5 mb-1.5">{children}</h3>
          ),
          p: ({ children }) => (
            <p className="text-sm leading-relaxed text-muted-foreground my-3">{children}</p>
          ),
          ul: ({ children }) => (
            <ul className="list-disc pl-6 space-y-1.5 text-sm leading-relaxed text-muted-foreground my-3">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal pl-6 space-y-1.5 text-sm leading-relaxed text-muted-foreground my-3">{children}</ol>
          ),
          li: ({ children }) => <li className="pl-1">{children}</li>,
          strong: ({ children }) => (
            <strong className="font-semibold text-foreground">{children}</strong>
          ),
          a: ({ href, children }) => (
            <a href={href} className="text-primary underline underline-offset-2 hover:opacity-80">{children}</a>
          ),
          hr: () => <hr className="my-8 border-border/60" />,
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-border pl-4 my-4 text-sm text-muted-foreground italic">{children}</blockquote>
          ),
          table: ({ children }) => (
            <div className="my-4 overflow-x-auto">
              <table className="w-full text-sm border-collapse">{children}</table>
            </div>
          ),
          th: ({ children }) => (
            <th className="border border-border px-3 py-1.5 text-left font-semibold">{children}</th>
          ),
          td: ({ children }) => (
            <td className="border border-border px-3 py-1.5 text-muted-foreground">{children}</td>
          ),
          code: ({ children }) => (
            <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">{children}</code>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
