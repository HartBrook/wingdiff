import ReactMarkdown, { type Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

const components: Components = {
  a({ children, href }) {
    const external = Boolean(href && !href.startsWith("#"));
    return <a href={href} {...(external ? { rel: "noreferrer", target: "_blank" } : {})}>{children}</a>;
  },
  img({ alt, src }) {
    if (typeof src !== "string" || !src) return null;
    return <a className="markdown-image-link" href={src} rel="noreferrer" target="_blank">Remote image: {alt || "open image"}</a>;
  },
};

export default function MarkdownContent({ fallback, source }: { fallback?: string; source: string }) {
  const value = source.trim() || fallback || "";
  return <div className="markdown-content">
    <ReactMarkdown components={components} rehypePlugins={[rehypeRaw, rehypeSanitize]} remarkPlugins={[remarkGfm]}>{value}</ReactMarkdown>
  </div>;
}
