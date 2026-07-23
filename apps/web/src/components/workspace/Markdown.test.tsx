import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

describe("Markdown", () => {
  it("renders a <script> tag from an LLM-generated statement as inert text, never executing it", () => {
    const marker = "__ALGOLIFT_XSS_MARKER__";
    (window as unknown as Record<string, unknown>)[marker] = false;
    const statement = `Two numbers sum to target.\n\n<script>window.${marker} = true;</script>\n\nReturn the indices.`;

    const { container } = render(<Markdown>{statement}</Markdown>);

    expect(container.querySelector("script")).not.toBeInTheDocument();
    expect((window as unknown as Record<string, unknown>)[marker]).toBe(false);
  });

  it("strips onerror handlers from an <img> tag instead of rendering them live", () => {
    const statement = `See the diagram: <img src="x" onerror="window.__ALGOLIFT_PWNED__ = true">`;
    const { container } = render(<Markdown>{statement}</Markdown>);

    const img = container.querySelector("img[onerror]");
    expect(img).not.toBeInTheDocument();
  });

  it("still renders ordinary markdown content, including fenced code blocks", () => {
    const statement = "A normal statement.\n\n```python\ndef f(x):\n    return x\n```\n";
    const { container, getByText } = render(<Markdown>{statement}</Markdown>);
    expect(getByText("A normal statement.")).toBeInTheDocument();
    expect(container.querySelector("pre code")).toBeInTheDocument();
  });
});
