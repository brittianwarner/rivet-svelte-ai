/**
 * Accept: text/markdown negotiation — unit coverage for the prerendered
 * fast-lane helper. HTML-only paths (no sibling) are a no-op by construction.
 */
import { describe, expect, test } from "bun:test";
import {
  appendVary,
  MARKDOWN_VARY,
  markdownPublicPath,
  markdownSiblingPaths,
  parseAccept,
  preferredType,
  prefersMarkdown,
  setMarkdownVary,
} from "../files/accept-negotiation.js";

describe("parseAccept", () => {
  test("splits type, q, and specificity", () => {
    const entries = parseAccept("text/markdown, text/html;q=0.8, */*;q=0.1");
    expect(entries).toEqual([
      { type: "text/markdown", q: 1, specificity: 2 },
      { type: "text/html", q: 0.8, specificity: 2 },
      { type: "*/*", q: 0.1, specificity: 0 },
    ]);
  });

  test("empty or missing header is an empty list", () => {
    expect(parseAccept(null)).toEqual([]);
    expect(parseAccept("")).toEqual([]);
  });
});

describe("preferredType / prefersMarkdown", () => {
  test("missing Accept defaults to HTML (first produce)", () => {
    expect(preferredType(null, ["text/html", "text/markdown"])).toBe("text/html");
    expect(prefersMarkdown(null)).toBe(false);
  });

  test("wildcard Accept stays on HTML", () => {
    expect(prefersMarkdown("*/*")).toBe(false);
    expect(prefersMarkdown("text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8")).toBe(
      false,
    );
  });

  test("markdown-first Accept wins", () => {
    expect(prefersMarkdown("text/markdown")).toBe(true);
    expect(prefersMarkdown("text/markdown, text/html;q=0.8")).toBe(true);
  });

  test("q-values beat source order", () => {
    expect(prefersMarkdown("text/html, text/markdown;q=0.1")).toBe(false);
    expect(prefersMarkdown("text/markdown;q=0.1, text/html")).toBe(false);
    expect(prefersMarkdown("text/html;q=0.2, text/markdown;q=0.9")).toBe(true);
  });

  test("q=0 rejects that type", () => {
    expect(prefersMarkdown("text/markdown;q=0, text/html")).toBe(false);
    expect(preferredType("text/markdown;q=0", ["text/html", "text/markdown"])).toBeNull();
  });
});

describe("markdown sibling paths", () => {
  test("homepage maps to /index.md", () => {
    expect(markdownSiblingPaths("/")).toEqual(["/index.md"]);
    expect(markdownSiblingPaths("")).toEqual(["/index.md"]);
    expect(markdownPublicPath("/")).toBe("/index.md");
  });

  test("inner pages try sibling then index", () => {
    expect(markdownSiblingPaths("/about")).toEqual(["/about.md", "/about/index.md"]);
    expect(markdownSiblingPaths("/about/")).toEqual(["/about.md", "/about/index.md"]);
    expect(markdownPublicPath("/about")).toBe("/about.md");
  });

  test("explicit .md URLs stay themselves", () => {
    expect(markdownSiblingPaths("/about.md")).toEqual(["/about.md"]);
  });
});

describe("appendVary", () => {
  test("sets Vary when absent", () => {
    const headers = new Headers();
    appendVary(headers, "Accept");
    expect(headers.get("vary")).toBe("Accept");
  });

  test("appends without duplicating Accept-Encoding", () => {
    const headers = new Headers({ vary: "Accept-Encoding" });
    appendVary(headers, "Accept");
    expect(headers.get("vary")).toBe("Accept-Encoding, Accept");
    appendVary(headers, "Accept");
    expect(headers.get("vary")).toBe("Accept-Encoding, Accept");
  });
});

describe("setMarkdownVary", () => {
  test("emits Accept, Accept-Encoding in that order", () => {
    const headers = new Headers();
    setMarkdownVary(headers);
    expect(headers.get("vary")).toBe(MARKDOWN_VARY);
  });

  test("rewrites an Accept-Encoding-only header to the required pair", () => {
    const headers = new Headers({ vary: "Accept-Encoding" });
    setMarkdownVary(headers);
    expect(headers.get("vary")).toBe("Accept, Accept-Encoding");
  });

  test("keeps unrelated tokens after the required pair", () => {
    const headers = new Headers({ vary: "Origin" });
    setMarkdownVary(headers);
    expect(headers.get("vary")).toBe("Accept, Accept-Encoding, Origin");
  });
});
