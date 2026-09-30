import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import MarkdownContent from "./MarkdownContent";

describe("MarkdownContent", () => {
  it("renders GitHub-flavored Markdown and sanitized HTML", () => {
    const html = renderToStaticMarkup(<MarkdownContent source={`## Intent

- Keep the counter atomic
- Preserve expiry

<details><summary>More context</summary>Safe details</details>

<script>alert("unsafe")</script>`} />);

    expect(html).toContain("<h2>Intent</h2>");
    expect(html).toContain("<li>Keep the counter atomic</li>");
    expect(html).toContain("<details>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("alert(");
  });

  it("opens links safely and does not load remote images", () => {
    const html = renderToStaticMarkup(<MarkdownContent source={`[Design](https://example.com/design)

![tracking pixel](https://example.com/pixel.png)`} />);

    expect(html).toContain('href="https://example.com/design"');
    expect(html).toContain('rel="noreferrer"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain("Remote image: tracking pixel");
    expect(html).not.toContain("<img");
  });
});
