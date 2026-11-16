/**
 * Static and prerendered request pipeline (files/handler.js) against a
 * synthetic adapter output tree — no SvelteKit build needed.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { startHarness, type Harness } from "./handler-harness";

const HELLO = "hello from the static fixture\n";
const BIG = new Uint8Array(200_000).map((_, index) => index % 251);

const client = {
  "hello.txt": HELLO,
  "hello.txt.br": brotliCompressSync(HELLO),
  "hello.txt.gz": gzipSync(HELLO),
  "utf.txt": "héllo\n",
  "s.css": "body{}\n",
  "logo.png": new Uint8Array([137, 80, 78, 71]),
  "big.bin": BIG,
  "café.txt": "cafe bytes",
  "a b.txt": "space bytes",
  "files/:x.txt": "colon bytes",
  "x/*.txt": "star bytes",
  "q?x.txt": "question bytes",
  "h#x.txt": "hash bytes",
  "files/:q?x#part.txt": "colon reserved bytes",
  "x/*?x#part.txt": "star reserved bytes",
  "literal%3F.txt": "literal percent bytes",
  "literal%2f.txt": "literal separator escape bytes",
  "reserved?x.txt": HELLO,
  "reserved?x.txt.br": brotliCompressSync(HELLO),
  ".secret": "hidden bytes",
  "hidden/.secret": "nested hidden bytes",
  "_app/immutable/app.js": "export {};\n",
  "zero.txt": "zero mtime bytes",
};

const prerenderedFiles = {
  "about/index.html": "<h1>about</h1>",
  "blog/über.html": "<h1>uber</h1>",
  "日本/index.html": "<h1>nihon</h1>",
  "llms.txt": "llms body\n",
};

const prerenderedPaths = ["/about/", "/blog/über", "/日本/", "/llms.txt"];

let harness: Harness;

beforeAll(async () => {
  harness = await startHarness({
    client,
    prerenderedFiles,
    prerenderedPaths,
    zeroMtime: ["client/zero.txt"],
  });
});

afterAll(async () => {
  await harness.stop();
});

async function expectSsr(response: Response): Promise<void> {
  expect(response.status).toBe(404);
  expect(((await response.json()) as { ssr: boolean }).ssr).toBe(true);
}

describe("A1 route keys with special characters", () => {
  test("reserved escapes are case insensitive in native and fallback routes", async () => {
    const cases: Array<[string, string]> = [
      ["/q%3fx.txt", "question bytes"],
      ["/h%23x.txt", "hash bytes"],
      ["/files/%3Aq%3Fx%23part.txt", "colon reserved bytes"],
      ["/files/%3aq%3fx%23part.txt", "colon reserved bytes"],
      ["/x/%2A%3Fx%23part.txt", "star reserved bytes"],
      ["/x/%2a%3fx%23part.txt?query=kept", "star reserved bytes"],
    ];
    for (const [path, body] of cases) {
      const response = await harness.fetch(path);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(body);
    }
  });

  test("percent literals are decoded exactly once", async () => {
    const cases: Array<[string, string]> = [
      ["/literal%253F.txt", "literal percent bytes"],
      ["/literal%252f.txt", "literal separator escape bytes"],
    ];
    for (const [path, body] of cases) {
      const response = await harness.fetch(path);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(body);
    }
    await expectSsr(await harness.fetch("/q%253Fx.txt"));
    await expectSsr(await harness.fetch("/literal%3F.txt"));
  });

  test("encoded separators and traversal never become asset index paths", async () => {
    for (const path of [
      "/files%2f:x.txt", "/files%2F:x.txt", "/files%5c:x.txt",
      "/x%2f*.txt", "/safe%2f..%2fhello.txt", "/safe%5c..%5chello.txt",
      "/%2esecret", "/%252esecret", "/hidden/%2esecret",
      "/safe%2f..%2f.secret", "/hello%00.txt", "/bad%ZZ.txt",
    ]) {
      const response = await harness.fetch(path);
      await expectSsr(response);
    }
  });

  test("fallback reserved filenames retain HEAD, compression and ranges", async () => {
    const head = await harness.fetch("/reserved%3fx.txt", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
    const compressed = await harness.fetch("/reserved%3fx.txt", {
      headers: { "accept-encoding": "br" },
    });
    expect(compressed.status).toBe(200);
    expect(compressed.headers.get("content-encoding")).toBe("br");
    expect(new Uint8Array(await compressed.arrayBuffer())).toEqual(brotliCompressSync(HELLO));
    const ranged = await harness.fetch("/reserved%3fx.txt", {
      headers: { "range": "bytes=0-4", "accept-encoding": "identity" },
    });
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe(HELLO.slice(0, 5));
  });

  test("SSR keeps the original URL encoding and query", async () => {
    const response = await harness.fetch("/missing%3f%23%2f%252F?actual=query");
    expect(response.status).toBe(404);
    const value = await response.json() as { url: string };
    expect(new URL(value.url).pathname).toBe("/missing%3f%23%2f%252F");
    expect(new URL(value.url).search).toBe("?actual=query");
  });

  test("encoded, spaced, colon, star and ? paths serve their own bytes", async () => {
    const cases: Array<[string, string]> = [
      ["/caf%C3%A9.txt", "cafe bytes"],
      ["/caf%c3%a9.txt", "cafe bytes"],
      ["/a%20b.txt", "space bytes"],
      ["/files/:x.txt", "colon bytes"],
      ["/x/*.txt", "star bytes"],
      ["/q%3Fx.txt", "question bytes"],
    ];
    for (const [path, body] of cases) {
      const response = await harness.fetch(path);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(body);
    }
  });

  test("siblings of ':' and '*' files reach SSR, not the file", async () => {
    await expectSsr(await harness.fetch("/files/other"));
    await expectSsr(await harness.fetch("/x/abc.txt"));
  });

  test("a unicode prerendered slug is served", async () => {
    const response = await harness.fetch("/blog/%C3%BCber");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("<h1>uber</h1>");
  });
});

describe("A2 malformed Host", () => {
  test("returns a plain 400", async () => {
    const head = await harness.raw(
      "GET /anything HTTP/1.1\r\nHost: evil.test/x#\r\nConnection: close\r\n\r\n",
    );
    expect(head.split("\r\n")[0]).toBe("HTTP/1.1 400 Bad Request");
    expect(head.toLowerCase()).toContain("content-type: text/plain");
  });
});

describe("A3 conditional GET", () => {
  test("If-None-Match list, weak form and * give 304", async () => {
    const initial = await harness.fetch("/hello.txt");
    const etag = initial.headers.get("etag") ?? "";
    expect(etag).not.toBe("");
    for (const header of [`"nope", ${etag}`, `W/${etag}`, "*"]) {
      const response = await harness.fetch("/hello.txt", {
        headers: { "if-none-match": header },
      });
      expect(response.status).toBe(304);
    }
  });

  test("a stale If-None-Match beats a future If-Modified-Since", async () => {
    const response = await harness.fetch("/hello.txt", {
      headers: {
        "if-none-match": '"stale"',
        "if-modified-since": new Date(Date.now() + 86_400_000).toUTCString(),
      },
    });
    expect(response.status).toBe(200);
  });

  test("If-Modified-Since equal to the echoed Last-Modified gives 304", async () => {
    const initial = await harness.fetch("/_app/immutable/app.js");
    const lastModified = initial.headers.get("last-modified") ?? "";
    expect(lastModified).not.toBe("");
    const response = await harness.fetch("/_app/immutable/app.js", {
      headers: { "if-modified-since": lastModified },
    });
    expect(response.status).toBe(304);
  });
});

describe("A4 Vary and q=0", () => {
  test("identity response for a path with siblings carries Vary", async () => {
    const response = await harness.fetch("/hello.txt", {
      headers: { "accept-encoding": "identity" },
    });
    expect(response.headers.get("content-encoding")).toBeNull();
    expect(response.headers.get("vary")).toBe("Accept-Encoding");
    expect(await response.text()).toBe(HELLO);
  });

  test("q=0 refuses an encoding", async () => {
    const refused = await harness.raw(
      "GET /hello.txt HTTP/1.1\r\nHost: x\r\nAccept-Encoding: gzip;q=0, br;q=0\r\nConnection: close\r\n\r\n",
    );
    expect(refused.toLowerCase()).not.toContain("content-encoding");
    expect(refused.toLowerCase()).toContain("vary: accept-encoding");

    const gzipOnly = await harness.raw(
      "GET /hello.txt HTTP/1.1\r\nHost: x\r\nAccept-Encoding: br;q=0, gzip\r\nConnection: close\r\n\r\n",
    );
    expect(gzipOnly.toLowerCase()).toContain("content-encoding: gzip");
  });

  test("a file without siblings has no Vary", async () => {
    const response = await harness.fetch("/utf.txt");
    expect(response.headers.get("vary")).toBeNull();
  });
});

describe("A5 server-sent events", () => {
  test("SSR event streams get X-Accel-Buffering: no", async () => {
    const response = await harness.fetch("/sse");
    expect(response.headers.get("x-accel-buffering")).toBe("no");
    await response.text();
  });

  test("an app-set value is kept", async () => {
    const response = await harness.fetch("/sse-explicit");
    expect(response.headers.get("x-accel-buffering")).toBe("yes");
    await response.text();
  });
});

describe("A6 content ETags", () => {
  test("non-immutable files get a strong content tag; immutable keep size-mtime", async () => {
    const page = await harness.fetch("/about/");
    expect(page.headers.get("etag")).toMatch(/^"[0-9a-f]+-[0-9a-f]+"$/);
    const asset = await harness.fetch("/_app/immutable/app.js");
    expect(asset.headers.get("etag")).toMatch(/^W\/"\d+-\d+"$/);
  });

  test("identical bytes in another build give the same tag", async () => {
    const other = await startHarness({ prerenderedFiles, prerenderedPaths });
    try {
      const [a, b] = await Promise.all([
        harness.fetch("/about/"),
        other.fetch("/about/"),
      ]);
      expect(a.headers.get("etag")).toBe(b.headers.get("etag"));
    } finally {
      await other.stop();
    }
  });

  test("a zero-mtime file: content tag, no Last-Modified, IMS ignored", async () => {
    const response = await harness.fetch("/zero.txt");
    const etag = response.headers.get("etag") ?? "";
    expect(etag).not.toEndWith('-0"');
    expect(etag.startsWith('"')).toBe(true);
    expect(response.headers.get("last-modified")).toBeNull();

    const ims = await harness.fetch("/zero.txt", {
      headers: { "if-modified-since": "Mon, 01 Jan 2001 00:00:00 GMT" },
    });
    expect(ims.status).toBe(200);
    const inm = await harness.fetch("/zero.txt", {
      headers: { "if-none-match": etag },
    });
    expect(inm.status).toBe(304);
  });
});

describe("A7 Range handled by Bun", () => {
  async function range(
    header: string,
    extra: Record<string, string> = {},
  ): Promise<{ status: number; contentRange: string | null; length: number }> {
    const response = await harness.fetch("/big.bin", {
      headers: { range: header, ...extra },
    });
    return {
      status: response.status,
      contentRange: response.headers.get("content-range"),
      length: (await response.arrayBuffer()).byteLength,
    };
  }

  test("single, suffix and unsatisfiable ranges", async () => {
    expect(await range("bytes=0-9")).toEqual({
      status: 206,
      contentRange: "bytes 0-9/200000",
      length: 10,
    });
    expect(await range("bytes=-5")).toEqual({
      status: 206,
      contentRange: "bytes 199995-199999/200000",
      length: 5,
    });
    expect((await range("bytes=500000-")).status).toBe(416);
  });

  test("multi-range, reversed and non-bytes units give the full 200", async () => {
    for (const header of ["bytes=0-1,5-6", "bytes=5-2", "items=0-1"]) {
      const result = await range(header);
      expect(result.status).toBe(200);
      expect(result.length).toBe(BIG.length);
    }
  });

  test("Accept-Ranges is sent exactly once on 200, 206, 416 and HEAD", async () => {
    const cases: Array<[Record<string, string>, string, number]> = [
      [{}, "GET", 200],
      [{ range: "bytes=0-9" }, "GET", 206],
      [{ range: "bytes=-5" }, "GET", 206],
      [{ range: "bytes=500000-" }, "GET", 416],
      [{ range: "bytes=0-1,5-6" }, "GET", 200],
      [{ range: "items=0-1" }, "GET", 200],
      [{ range: "bytes=0-9", "if-range": '"stale"' }, "GET", 200],
      [{}, "HEAD", 200],
    ];
    for (const [headers, method, status] of cases) {
      const response = await harness.fetch("/big.bin", { method, headers });
      await response.arrayBuffer();
      expect(response.status).toBe(status);
      expect(response.headers.get("accept-ranges")).toBe("bytes");
    }
    for (const range of ["bytes=0-9", "bytes=500000-"]) {
      const head = await harness.raw(
        `GET /big.bin HTTP/1.1\r\nHost: localhost\r\nRange: ${range}\r\nConnection: close\r\n\r\n`,
      );
      expect(head.match(/^accept-ranges:/gim)?.length).toBe(1);
    }
  });

  test("a .br variant with Range keeps content-encoding and ETag", async () => {
    const response = await harness.fetch("/hello.txt", {
      headers: { "accept-encoding": "br", range: "bytes=0-3" },
    });
    expect(response.status).toBe(206);
    expect(response.headers.get("content-encoding")).toBe("br");
    expect(response.headers.get("etag")).not.toBeNull();
    await response.arrayBuffer();
  });

  test("HEAD returns Content-Length and no body", async () => {
    const response = await harness.fetch("/big.bin", { method: "HEAD" });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-length")).toBe(String(BIG.length));
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  test("If-Range: a stale or weak validator sends the full file", async () => {
    for (const ifRange of [
      '"stale"',
      'W/"x"',
      "Mon, 01 Jan 2001 00:00:00 GMT",
    ]) {
      const result = await range("bytes=0-9", { "if-range": ifRange });
      expect(result.status).toBe(200);
      expect(result.length).toBe(BIG.length);
    }
  });

  test("If-Range: the current strong ETag or Last-Modified keeps the range", async () => {
    const head = await harness.fetch("/big.bin", { method: "HEAD" });
    const etag = head.headers.get("etag") ?? "";
    const lastModified = head.headers.get("last-modified") ?? "";
    expect((await range("bytes=0-9", { "if-range": etag })).status).toBe(206);
    expect(
      (await range("bytes=0-9", { "if-range": lastModified })).status,
    ).toBe(206);
  });

  test("the full body is byte-identical", async () => {
    const response = await harness.fetch("/big.bin");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(BIG);
  });
});

describe("A8 content types with charset", () => {
  test("text types carry charset=utf-8", async () => {
    const cases: Array<[string, string]> = [
      ["/utf.txt", "text/plain;charset=utf-8"],
      ["/s.css", "text/css;charset=utf-8"],
      ["/_app/immutable/app.js", "text/javascript;charset=utf-8"],
      ["/llms.txt", "text/plain;charset=utf-8"],
      ["/about/", "text/html;charset=utf-8"],
      ["/logo.png", "image/png"],
    ];
    for (const [path, type] of cases) {
      const response = await harness.fetch(path);
      expect(response.headers.get("content-type")).toBe(type);
      await response.arrayBuffer();
    }
  });

  test("an encoded variant is labelled with the decoded type", async () => {
    const response = await harness.fetch("/hello.txt", {
      headers: { "accept-encoding": "gzip" },
    });
    expect(response.headers.get("content-type")).toBe(
      "text/plain;charset=utf-8",
    );
    await response.arrayBuffer();
  });
});

describe("A9 redirect Location encoding", () => {
  test("a unicode redirect is percent-encoded (router and fallback)", async () => {
    for (const path of ["/%E6%97%A5%E6%9C%AC", "/%e6%97%a5%e6%9c%ac"]) {
      const response = await harness.fetch(`${path}?a=1`, {
        redirect: "manual",
      });
      expect(response.status).toBe(308);
      expect(response.headers.get("location")).toBe("/%E6%97%A5%E6%9C%AC/?a=1");
    }
  });
});

describe("A10 SSR request clone", () => {
  test("method, headers, body and rebuilt URL reach the app", async () => {
    const response = await harness.fetch("/echo?x=1", {
      method: "POST",
      headers: { "x-probe": "kept" },
      body: "payload",
    });
    expect(response.status).toBe(200);
    const echoed = (await response.json()) as Record<string, unknown>;
    expect(echoed.method).toBe("POST");
    expect(echoed.header).toBe("kept");
    expect(echoed.body).toBe("payload");
    expect(String(echoed.url)).toEndWith("/echo?x=1");
  });

  test("a client disconnect aborts the SSR request signal", async () => {
    const controller = new AbortController();
    const pending = harness
      .fetch("/slow", { signal: controller.signal })
      .catch(() => undefined);
    await Bun.sleep(100);
    controller.abort();
    await pending;
    await Bun.sleep(200);
    expect(Reflect.get(globalThis, "__slowAborted")).toBe(true);
  });
});

describe("A11 per-method route objects", () => {
  test("POST, PUT and OPTIONS to a static path reach SSR", async () => {
    for (const method of ["POST", "PUT", "OPTIONS"]) {
      await expectSsr(await harness.fetch("/hello.txt", { method }));
    }
  });
});

describe("build-owned asset boundary", () => {
  test("files added to the output directory before boot are not public assets", async () => {
    const isolated = await startHarness({
      client: { "public.txt": "public" },
      unlistedClient: {
        "private.txt": "private",
        "_app/immutable/private.js": "private script",
        "public.txt.gz": "unlisted compressed variant",
      },
    });
    try {
      expect(await (await isolated.fetch("/public.txt")).text()).toBe("public");
      await expectSsr(await isolated.fetch("/private.txt"));
      await expectSsr(await isolated.fetch("/public.txt.gz"));
      await expectSsr(await isolated.fetch("/_app/immutable/private.js"));
    } finally {
      await isolated.stop();
    }
  });
});
