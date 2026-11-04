import { expect, it } from "vite-plus/test";
import { escapeHtml, safeIconUrl, safeNavigationUrl } from "./safety.ts";

it("escapes quotes, ampersands, and angle brackets for text and attributes", () => {
  expect(escapeHtml(`Tom & Jerry's "Best" <show>`)).toBe(
    "Tom &amp; Jerry&#39;s &quot;Best&quot; &lt;show&gt;",
  );
  expect(escapeHtml("Movies & TV")).toBe("Movies &amp; TV");
});

it("neutralizes double-quoted attribute injection", () => {
  const description = `Movies & TV" onmouseover="alert(1)`;
  const markup = `<a title="${escapeHtml(description)}">`;
  expect(markup).toBe(`<a title="Movies &amp; TV&quot; onmouseover=&quot;alert(1)">`);
  expect(markup).not.toContain('onmouseover="alert');
});

it("neutralizes single-quoted attribute injection", () => {
  expect(escapeHtml(`' onfocus='alert(1)`)).toBe("&#39; onfocus=&#39;alert(1)");
});

it.each([
  "https://example.com",
  "http://192.168.1.1:8080/admin?x=1&y=2#top",
  "HTTPS://Example.COM/path",
])("accepts ordinary navigation URL %s", (value) => {
  expect(safeNavigationUrl(value)).toBe(value);
});

it.each([
  "javascript:alert(1)",
  "JaVaScRiPt:alert(1)",
  "  javascript:alert(1)",
  "\tjava\nscript:alert(1)",
  "&#106;avascript:alert(1)",
  "javascript&#58;alert(1)",
  "%6aavascript:alert(1)",
  "\u0000javascript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "vbscript:msgbox(1)",
  "file:///etc/passwd",
  "blob:https://example.com/id",
  "//example.com/path",
  "/relative/path",
])("rejects unsafe navigation URL %j", (value) => {
  expect(safeNavigationUrl(value)).toBeNull();
});

it("escapes quote-bearing navigation URLs", () => {
  const url = safeNavigationUrl('https://example.com/" onmouseover="alert(1)');
  expect(url).toBe('https://example.com/" onmouseover="alert(1)');
  if (url === null) return;

  const attribute = `href="${escapeHtml(url)}"`;
  expect(attribute).not.toContain('onmouseover="alert');
  expect(attribute).toContain("&quot;");
});

it.each([
  ["https://cdn.example.com/icon.svg", "https://cdn.example.com/icon.svg"],
  ["HTTP://example.com/icon.png", "http://example.com/icon.png"],
  ["/icons/icon.svg", "/icons/icon.svg"],
  ["/icons/icon.svg?v=2#dark", "/icons/icon.svg?v=2#dark"],
  ["  /icons/icon.svg  ", "/icons/icon.svg"],
])("accepts ordinary icon source %s", (value, expected) => {
  expect(safeIconUrl(value)).toBe(expected);
});

it.each([
  "javascript:alert(1)",
  "data:image/svg+xml,<svg/onload=alert(1)>",
  "file:///tmp/icon.svg",
  "//example.com/icon.svg",
  "/\\example.com/icon.svg",
  "/\t/example.com/icon.svg",
  "icons/icon.svg",
  "🎬",
])("rejects unsafe or non-image icon source %j", (value) => {
  expect(safeIconUrl(value)).toBeNull();
});

it("escapes quotes in root-relative icon paths", () => {
  const icon = safeIconUrl('/icons/a" onerror="alert(1).svg');
  expect(icon).not.toBeNull();
  if (icon === null) return;

  const attribute = `src="${escapeHtml(icon)}"`;
  expect(attribute).not.toContain('" onerror');
  expect(attribute).toContain("&quot;");
});
