import { expect, it } from "vite-plus/test";
import { parseRequestUrl } from "./request-url.ts";

it.each(["http://%", "http://[invalid", "http://host:badport"])(
  "rejects malformed request target %s",
  (target) => {
    expect(parseRequestUrl(target)).toBeNull();
  },
);

it.each([
  [undefined, "/"],
  ["", "/"],
  ["/", "/"],
  ["/api/ping?url=https%3A%2F%2Fexample.com%2F", "/api/ping"],
])("parses origin-form target %s", (target, pathname) => {
  expect(parseRequestUrl(target)?.pathname).toBe(pathname);
});

it("preserves query parameters on origin-form targets", () => {
  const url = parseRequestUrl("/api/ping?url=https%3A%2F%2Fexample.com%2F&other=1");
  expect(url?.searchParams.get("url")).toBe("https://example.com/");
  expect(url?.searchParams.get("other")).toBe("1");
});

it("routes absolute-form targets by their path and query", () => {
  const url = parseRequestUrl(
    "http://proxy.example:8080/api/ping?url=https%3A%2F%2Fexample.com%2F",
  );
  expect(url?.host).toBe("proxy.example:8080");
  expect(url?.pathname).toBe("/api/ping");
  expect(url?.searchParams.get("url")).toBe("https://example.com/");
});
