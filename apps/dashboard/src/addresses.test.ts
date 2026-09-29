// @vitest-environment node
import { createServer } from "node:http";
import { once } from "node:events";
import { expect, it } from "vitest";
import {
  checkPath,
  checkUrl,
  entityPath,
  entityUrl,
  eventPath,
  eventUrl,
  relationshipPath,
} from "./addresses";

it("sends caller-owned identifiers intact through WHATWG fetch without path normalization", async () => {
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ path: request.url }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("Missing test listener");
    const origin = `http://127.0.0.1:${address.port}`;
    for (const id of [
      ".",
      "..",
      "%2e",
      "%2E",
      "%2e%2e",
      ".%2e",
      "a/b?c#d&x=1+ 雪",
    ]) {
      // The address builder preserves values; each endpoint still enforces its own domain validator.
      const cases = [
        [checkPath(id), "/lookup/checks", "name"],
        [checkPath(id, "/versions/1"), "/lookup/checks/versions/1", "name"],
        [checkPath(id, "/draft"), "/lookup/checks/draft", "name"],
        [checkUrl(id), "/inspect/check", "name"],
        [eventPath(id), "/lookup/events", "id"],
        [eventUrl(id), "/inspect/event", "id"],
        [entityPath("user", id), "/lookup/entities", "id"],
        [
          entityPath("user", id, "/relationships"),
          "/lookup/entities/relationships",
          "id",
        ],
        [entityUrl("user", id), "/inspect/entity", "id"],
        [
          relationshipPath({ kind: "backend", id }, "/corrections"),
          "/lookup/relationships/corrections",
          "id",
        ],
        [
          relationshipPath({ kind: "backend", id }, "/restorations"),
          "/lookup/relationships/restorations",
          "id",
        ],
      ];
      for (const [path, pathname, selector] of cases) {
        const received = (await (await fetch(`${origin}${path}`)).json()) as {
          path: string;
        };
        const url = new URL(received.path, origin);
        expect(url.pathname).toBe(pathname);
        expect(url.searchParams.get(selector!)).toBe(id);
        expect(url.searchParams.getAll(selector!)).toHaveLength(1);
      }
    }
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
