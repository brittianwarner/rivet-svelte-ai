/**
 * Pure HTTP helpers (files/http.js) plus the markdown alternate Link header
 * against a synthetic prerendered tree.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  acceptsEncoding,
  contentEtag,
  contentTypeFor,
  encodePathname,
  httpDateMs,
  ifNoneMatchMatches,
  ifRangeMatches,
  isNotModified,
  markdownAlternateLink,
  markEventStreamUnbuffered,
  redirectLocation,
  routeKey,
} from "../files/http.js";
import { startHarness, type Harness } from "./handler-harness";

describe("routeKey / encodePathname", () => {
  test("encodes non-ASCII, spaces, %, ? and #", () => {
    expect(routeKey("/café.txt")).toBe("/caf%C3%A9.txt");
    expect(routeKey("/a b.txt")).toBe("/a%20b.txt");
    expect(routeKey("/100%.txt")).toBe("/100%25.txt");
    expect(routeKey("/q?x.txt")).toBe("/q%3Fx.txt");
    expect(routeKey("/h#x.txt")).toBe("/h%23x.txt");
    expect(routeKey("/blog/über")).toBe("/blog/%C3%BCber");
  });

  test("skips router syntax", () => {
    expect(routeKey("/files/:x.txt")).toBeUndefined();
    expect(routeKey("/:x")).toBeUndefined();
    expect(routeKey("/x/*.txt")).toBeUndefined();
    expect(routeKey("/a:b.txt")).toBe("/a:b.txt");
  });

  test("an unencodable path has no key", () => {
    expect(encodePathname("/\uD800")).toBeUndefined();
    expect(routeKey("/\uD800")).toBeUndefined();
  });
});

describe("acceptsEncoding", () => {
  test("plain tokens, case-insensitive", () => {
    expect(acceptsEncoding({ header: "gzip, BR", encoding: "br" })).toBe(true);
    expect(acceptsEncoding({ header: "gzip", encoding: "br" })).toBe(false);
    expect(acceptsEncoding({ header: "", encoding: "br" })).toBe(false);
    expect(acceptsEncoding({ header: null, encoding: "gzip" })).toBe(false);
  });

  test("q=0 refuses", () => {
    expect(acceptsEncoding({ header: "br;q=0", encoding: "br" })).toBe(false);
    expect(acceptsEncoding({ header: "br; q=0.000", encoding: "br" })).toBe(
      false,
    );
    expect(acceptsEncoding({ header: "br;q=0.5", encoding: "br" })).toBe(true);
    expect(acceptsEncoding({ header: "br;q=bogus", encoding: "br" })).toBe(
      true,
    );
  });

  test("wildcard applies only to unlisted encodings", () => {
    expect(acceptsEncoding({ header: "*", encoding: "gzip" })).toBe(true);
    expect(acceptsEncoding({ header: "*;q=0", encoding: "gzip" })).toBe(false);
    expect(acceptsEncoding({ header: "br;q=0, *", encoding: "br" })).toBe(
      false,
    );
    expect(acceptsEncoding({ header: "gzip, *;q=0", encoding: "gzip" })).toBe(
      true,
    );
  });
});

describe("conditional requests", () => {
  const etag = '"abc"';
  const mtimeMs = 1_790_621_808_136.95;
  const lastModified = new Date(mtimeMs).toUTCString();

  test("If-None-Match: list, weak and *", () => {
    expect(ifNoneMatchMatches({ header: '"x", "abc"', etag })).toBe(true);
    expect(ifNoneMatchMatches({ header: 'W/"abc"', etag })).toBe(true);
    expect(ifNoneMatchMatches({ header: '"abc"', etag: 'W/"abc"' })).toBe(true);
    expect(ifNoneMatchMatches({ header: "*", etag })).toBe(true);
    expect(ifNoneMatchMatches({ header: '"x"', etag })).toBe(false);
  });

  test("If-Modified-Since compares whole seconds", () => {
    expect(httpDateMs(mtimeMs)).toBe(Date.parse(lastModified));
    expect(
      isNotModified({
        ifNoneMatch: null,
        ifModifiedSince: lastModified,
        etag,
        mtimeMs,
      }),
    ).toBe(true);
  });

  test("If-None-Match present means If-Modified-Since is ignored", () => {
    expect(
      isNotModified({
        ifNoneMatch: '"stale"',
        ifModifiedSince: new Date(mtimeMs + 86_400_000).toUTCString(),
        etag,
        mtimeMs,
      }),
    ).toBe(false);
  });

  test("zero mtime ignores If-Modified-Since", () => {
    expect(
      isNotModified({
        ifNoneMatch: null,
        ifModifiedSince: "Mon, 01 Jan 2001 00:00:00 GMT",
        etag,
        mtimeMs: 0,
      }),
    ).toBe(false);
  });

  test("malformed dates never match", () => {
    expect(
      isNotModified({
        ifNoneMatch: null,
        ifModifiedSince: "yesterday",
        etag,
        mtimeMs,
      }),
    ).toBe(false);
  });

  test("If-Range: strong tag, exact date; weak never matches", () => {
    expect(ifRangeMatches({ header: '"abc"', etag, lastModified })).toBe(true);
    expect(ifRangeMatches({ header: '"x"', etag, lastModified })).toBe(false);
    expect(ifRangeMatches({ header: 'W/"abc"', etag, lastModified })).toBe(
      false,
    );
    expect(
      ifRangeMatches({ header: 'W/"1-2"', etag: 'W/"1-2"', lastModified }),
    ).toBe(false);
    expect(
      ifRangeMatches({ header: '"1-2"', etag: 'W/"1-2"', lastModified }),
    ).toBe(false);
    expect(ifRangeMatches({ header: lastModified, etag, lastModified })).toBe(
      true,
    );
    expect(
      ifRangeMatches({
        header: "Mon, 01 Jan 2001 00:00:00 GMT",
        etag,
        lastModified,
      }),
    ).toBe(false);
    expect(
      ifRangeMatches({ header: lastModified, etag, lastModified: undefined }),
    ).toBe(false);
  });
});

describe("contentEtag", () => {
  test("stable for equal bytes, distinct otherwise, chunk-independent of mtime", async () => {
    const a = new Blob(["same bytes"]);
    const b = new Blob(["same bytes"]);
    const c = new Blob(["other bytes"]);
    const tag = async (blob: Blob, chunkSize?: number) =>
      contentEtag({
        file: blob as unknown as import("bun").BunFile,
        size: blob.size,
        chunkSize,
      });
    expect(await tag(a)).toBe(await tag(b));
    expect(await tag(a)).not.toBe(await tag(c));
    expect(await tag(a)).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
    expect(await tag(a, 3)).toBe(await tag(b, 3));
    expect(await tag(new Blob([]))).toMatch(/^"[0-9a-f]+-0"$/);
  });
});

describe("contentTypeFor", () => {
  test("text types carry charset; unknown falls back to octet-stream", () => {
    expect(contentTypeFor({ path: "/a.txt", abs: "/x/a.txt" })).toBe(
      "text/plain;charset=utf-8",
    );
    expect(contentTypeFor({ path: "/a.css", abs: "/x/a.css" })).toBe(
      "text/css;charset=utf-8",
    );
    expect(contentTypeFor({ path: "/a.mjs", abs: "/x/a.mjs" })).toBe(
      "text/javascript;charset=utf-8",
    );
    expect(contentTypeFor({ path: "/a.md", abs: "/x/a.md" })).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(contentTypeFor({ path: "/a.unknownext", abs: "/x/a" })).toBe(
      "application/octet-stream",
    );
    expect(contentTypeFor({ path: "/dir.v2/file", abs: "/x/file" })).toBe(
      "application/octet-stream",
    );
  });

  test("a direct .br request keeps the decoded file's type", () => {
    expect(contentTypeFor({ path: "/a.txt.br", abs: "/x/a.txt.br" })).toBe(
      "text/plain;charset=utf-8",
    );
  });
});

describe("markEventStreamUnbuffered", () => {
  test("marks event streams only", () => {
    const sse = markEventStreamUnbuffered(
      new Response("", {
        headers: { "content-type": "text/event-stream; charset=utf-8" },
      }),
    );
    expect(sse.headers.get("x-accel-buffering")).toBe("no");
    const html = markEventStreamUnbuffered(
      new Response("", { headers: { "content-type": "text/html" } }),
    );
    expect(html.headers.get("x-accel-buffering")).toBeNull();
  });
});

describe("Link and Location builders", () => {
  test("encode the public path", () => {
    expect(markdownAlternateLink("/about/index.md")).toBe(
      '</about/index.md>; rel="alternate"; type="text/markdown"',
    );
    expect(markdownAlternateLink("/über.md")).toBe(
      '</%C3%BCber.md>; rel="alternate"; type="text/markdown"',
    );
    expect(redirectLocation({ pathname: "/日本/", search: "?a=1" })).toBe(
      "/%E6%97%A5%E6%9C%AC/?a=1",
    );
  });
});

describe("A9 markdown alternate Link header", () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness({
      prerenderedFiles: {
        "about/index.html": "<h1>about</h1>",
        "about/index.md": "# about",
        "guide.html": "<h1>guide</h1>",
        "guide.md": "# guide",
      },
      // Kit lists the .md mirrors (routes like about.md/+server.ts) as
      // prerendered paths too, so they are directly servable.
      prerenderedPaths: ["/about/", "/about/index.md", "/guide", "/guide.md"],
    });
  });

  afterAll(async () => {
    await harness.stop();
  });

  test("a trailing-slash page advertises the .md file that exists", async () => {
    const page = await harness.fetch("/about/");
    expect(page.headers.get("link")).toBe(
      '</about/index.md>; rel="alternate"; type="text/markdown"',
    );
    expect(page.headers.get("vary")).toBe("Accept, Accept-Encoding");
    const markdown = await harness.fetch("/about/index.md");
    expect(markdown.status).toBe(200);
    expect(await markdown.text()).toBe("# about");
  });

  test("a sibling .md page advertises /guide.md", async () => {
    const page = await harness.fetch("/guide");
    expect(page.headers.get("link")).toBe(
      '</guide.md>; rel="alternate"; type="text/markdown"',
    );
  });

  test("Accept: text/markdown serves the markdown", async () => {
    const page = await harness.fetch("/about/", {
      headers: { accept: "text/markdown" },
    });
    expect(page.headers.get("content-type")).toBe(
      "text/markdown; charset=utf-8",
    );
    expect(await page.text()).toBe("# about");
  });
});
