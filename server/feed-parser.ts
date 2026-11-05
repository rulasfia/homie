import { XMLParser } from "fast-xml-parser";
import { compareFeedArticles, feedUrl, MAX_FEED_ITEMS } from "../shared/feeds.ts";
import type { FeedArticle } from "../shared/types.ts";

const parserOptions = {
  ignoreAttributes: false,
  preserveOrder: true,
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: false,
  htmlEntities: true,
  cdataPropName: "#cdata",
  maxNestedTags: 32,
  processEntities: {
    enabled: true,
    maxEntityCount: 0,
    maxTotalExpansions: 100_000,
    maxExpandedLength: 1_048_576,
  },
};

function isNode(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nodes(value: unknown) {
  return (Array.isArray(value) ? value : [value]).filter(isNode);
}

function children(node: Record<string, unknown>, tag: string) {
  return Object.entries(node)
    .filter(([key]) => key !== ":@")
    .flatMap(([, value]) => nodes(value))
    .filter((child) => Object.hasOwn(child, tag));
}

function attribute(node: Record<string, unknown>, name: string) {
  const attrs = node[":@"];
  return isNode(attrs) ? attrs[`@_${name}`] : undefined;
}

/** Security preflight only; XML syntax is still validated by the parser. */
function rejectDeclarations(xml: string) {
  if (xml.includes("\0")) throw new Error("invalid-feed");
  let position = 0;
  while ((position = xml.indexOf("<!", position)) !== -1) {
    // Literal examples inside article CDATA/comments are not XML declarations.
    const endToken = xml.startsWith("<![CDATA[", position)
      ? "]]>"
      : xml.startsWith("<!--", position)
        ? "-->"
        : undefined;
    if (endToken) {
      const end = xml.indexOf(endToken, position + (endToken === "]]>" ? 9 : 4));
      if (end === -1) throw new Error("invalid-feed");
      position = end + endToken.length;
      continue;
    }
    const token = xml.slice(position, position + 9).toUpperCase();
    if (token.startsWith("<!DOCTYPE") || token.startsWith("<!ENTITY"))
      throw new Error("invalid-feed");
    position += 2;
  }
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(text).join("");
  if (!isNode(value)) return "";
  return Object.entries(value)
    .filter(([key]) => key !== ":@" && !key.startsWith("@_"))
    .map(([key, child]) => {
      if (key !== "#cdata") return text(child);
      // CDATA may contain HTML entities. Escape markup before decoding text only.
      const decoded: unknown = new XMLParser(parserOptions).parse(
        `<text>${text(child).replace(/</g, "&lt;").replace(/>/g, "&gt;")}</text>`,
      );
      return text(decoded);
    })
    .join("");
}

function withBase(node: Record<string, unknown>, base: string) {
  const value = attribute(node, "base");
  return typeof value === "string" ? (feedUrl(value, base)?.href ?? base) : base;
}

function article(entry: Record<string, unknown>, base: string, atom: boolean, now: number) {
  const titleNode = children(entry, "title")[0];
  const titleText = text(titleNode);
  const titleType = titleNode && attribute(titleNode, "type");
  // Atom text and XHTML nodes are already plain; escaped HTML still needs stripping.
  // Excluding '<' inside a tag keeps stripping linear even for malformed HTML.
  const plainTitle =
    atom && titleType !== "html" ? titleText : titleText.replace(/<\/?[a-z][^<>]*>/gi, " ");
  const title = plainTitle.replace(/\s+/g, " ").trim().slice(0, 500);
  if (!title) return undefined;
  const entryBase = withBase(entry, base);
  let url: URL | null = null;
  if (atom) {
    const links = children(entry, "link").filter(
      (link) =>
        (attribute(link, "rel") === undefined || attribute(link, "rel") === "alternate") &&
        (attribute(link, "type") === undefined ||
          attribute(link, "type") === "text/html" ||
          attribute(link, "type") === "application/xhtml+xml"),
    );
    for (const link of links) {
      const href = attribute(link, "href");
      if (typeof href !== "string") continue;
      url = feedUrl(href, withBase(link, entryBase));
      if (url) break;
    }
  } else {
    const link = text(children(entry, "link")[0]).trim();
    if (link) url = feedUrl(link, entryBase);
  }
  if (!url) return undefined;
  const published = Date.parse(text(children(entry, atom ? "published" : "pubDate")[0]));
  const result: FeedArticle = { title, url: url.href };
  if (Number.isFinite(published) && published <= now)
    result.publishedAt = new Date(published).toISOString();
  return result;
}

/** Keep at most five recent, distinct headlines. Never resolve DTD entities. */
export function parseFeed(xml: string, url: string, now: number) {
  rejectDeclarations(xml);
  const document: unknown = new XMLParser(parserOptions).parse(xml, true);
  const root = nodes(document).find(
    (node) => Object.hasOwn(node, "feed") || Object.hasOwn(node, "rss"),
  );
  if (!root) throw new Error("invalid-feed");
  const atom = Object.hasOwn(root, "feed");
  if (!atom && attribute(root, "version") !== "2.0") throw new Error("invalid-feed");
  const container = atom ? root : children(root, "channel")[0];
  if (!container) throw new Error("invalid-feed");
  const rootBase = withBase(root, url);
  const base = atom ? rootBase : withBase(container, rootBase);
  const articles: FeedArticle[] = [];
  for (const entry of children(container, atom ? "entry" : "item")) {
    const candidate = article(entry, base, atom, now);
    if (!candidate) continue;
    const duplicate = articles.findIndex((article) => article.url === candidate.url);
    if (duplicate !== -1) {
      if (compareFeedArticles(candidate, articles[duplicate]) >= 0) continue;
      articles.splice(duplicate, 1);
    }
    articles.push(candidate);
    articles.sort(compareFeedArticles);
    if (articles.length > MAX_FEED_ITEMS) articles.pop();
  }
  return articles;
}
