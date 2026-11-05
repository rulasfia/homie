import { expect, it } from "vite-plus/test";
import { parseFeed } from "./feed-parser.ts";

const now = Date.parse("2026-11-05T12:00:00Z");
const url = "https://blog.test/feed.xml";
const rss = (items: string) => `<rss version="2.0"><channel>${items}</channel></rss>`;
const item = (title: string, link = "/article", date = "") =>
  `<item><title>${title}</title><link>${link}</link><pubDate>${date}</pubDate></item>`;

it("sorts usable articles rather than trusting XML order, decoding text and links", () => {
  const xml = rss(
    item("Old", "/old", "2026-10-01") +
      item("A &amp; B &#x1f331;", "/new?a=1&amp;b=2", "2026-11-04") +
      item("Unsafe", "javascript:alert(1)", "2026-11-05") +
      "<item><title>No link</title><guid>https://blog.test/guid</guid></item>",
  );
  expect(parseFeed(xml, url, now)).toEqual([
    {
      title: "A & B 🌱",
      url: "https://blog.test/new?a=1&b=2",
      publishedAt: "2026-11-04T00:00:00.000Z",
    },
    { title: "Old", url: "https://blog.test/old", publishedAt: "2026-10-01T00:00:00.000Z" },
  ]);
});

it("handles CDATA HTML titles as text and bounds retained titles", () => {
  expect(parseFeed(rss(item("<![CDATA[<b>A &amp; B</b>]]>")), url, now)[0]?.title).toBe("A & B");
  expect(parseFeed(rss(item("a".repeat(1000))), url, now)[0]?.title).toHaveLength(500);
});

it("allows declaration examples inside unused article CDATA and comments", () => {
  const xml = rss(
    item("Hello") +
      "<description><![CDATA[An example: <!DOCTYPE html>]]></description><!-- <!ENTITY literal> -->",
  );
  expect(parseFeed(xml, url, now)[0]?.title).toBe("Hello");
});

it("preserves plain-text angle brackets and article fragments", () => {
  const xml =
    '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Use &lt;script&gt; carefully: 1 &lt; 2 &gt; 0</title><link href="/article#section"/></entry></feed>';
  expect(parseFeed(xml, url, now)).toEqual([
    {
      title: "Use <script> carefully: 1 < 2 > 0",
      url: "https://blog.test/article#section",
    },
  ]);
  expect(parseFeed(rss(item("1 &lt; 2 &gt; 0")), url, now)[0]?.title).toBe("1 < 2 > 0");
});

it("supports prefixed Atom, inherited xml:base, XHTML titles, and alternate links only", () => {
  const xml = `<a:feed xmlns:a="http://www.w3.org/2005/Atom" xml:base="posts/">
    <a:entry xml:base="2026/">
      <a:title type="xhtml"><div xmlns="http://www.w3.org/1999/xhtml">Hello <b>world</b>!</div></a:title>
      <a:published>2026-11-04T10:00:00Z</a:published>
      <a:link rel="self" href="/feed/entry" />
      <a:link rel="enclosure" href="/audio.mp3" />
      <a:link rel="alternate" type="text/html" xml:base="nov/" href="hello" />
    </a:entry>
  </a:feed>`;
  const [article] = parseFeed(xml, url, now);
  expect(article?.url).toBe("https://blog.test/posts/2026/nov/hello");
  expect(article?.title).toBe("Hello world!");
});

it("uses first usable entry when dates are missing, invalid, or in the future", () => {
  const xml = rss(item("First", "/first", "not a date") + item("Future", "/future", "2099-01-01"));
  expect(parseFeed(xml, url, now)).toEqual([
    { title: "First", url: "https://blog.test/first" },
    { title: "Future", url: "https://blog.test/future" },
  ]);
  expect(
    parseFeed(rss(item("Undated") + item("Dated", "/dated", "2026-01-01")), url, now)[0]?.title,
  ).toBe("Dated");
});

it("recognizes successful empty RSS and Atom feeds", () => {
  expect(parseFeed(rss(""), url, now)).toEqual([]);
  expect(parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"/>', url, now)).toEqual([]);
});

it("retains only the five newest distinct article URLs", () => {
  const items = Array.from({ length: 9 }, (_, index) =>
    item(`Item ${index}`, `/item/${index}`, `2026-10-${10 + index}`),
  );
  const xml = rss(items.join("") + item("Duplicate", "/item/8", "2026-10-18"));
  const articles = parseFeed(xml, url, now);
  expect(articles.map((article) => article.title)).toEqual([
    "Item 8",
    "Item 7",
    "Item 6",
    "Item 5",
    "Item 4",
  ]);
  expect(new Set(articles.map((article) => article.url)).size).toBe(5);
});

it.each([
  '<rss version="2.0"><channel><item></channel></rss>',
  "<html><body>Not a feed</body></html>",
  '<!DOCTYPE rss [<!ENTITY a SYSTEM "file:///etc/passwd">]><rss version="2.0"><channel/></rss>',
  '<!DOCTYPE rss [<!ENTITY a "&a;&a;">]><rss version="2.0"><channel/></rss>',
  `<rss version="2.0"><channel>${"<a>".repeat(40)}${"</a>".repeat(40)}</channel></rss>`,
])("rejects malformed, unsupported, DTD, or deeply nested documents %#", (xml) => {
  expect(() => parseFeed(xml, url, now)).toThrow();
});
