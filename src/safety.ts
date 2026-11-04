const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

/** Escapes text for both HTML text nodes and double-quoted attribute values. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

const ALLOWED_URL_PROTOCOLS = new Set(["http:", "https:"]);

function httpUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ALLOWED_URL_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

// Root-relative icons must have exactly one leading slash and no backslashes or
// control characters, which browsers can reinterpret as a protocol-relative URL.
function isRootRelativeIcon(value: string): boolean {
  if (!value.startsWith("/") || value.startsWith("//")) return false;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (char === "\\" || code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * Returns the original absolute http(s) navigation URL, or null. Keeping the
 * original keeps ping URLs byte-for-byte compatible with the config allowlist.
 */
export function safeNavigationUrl(value: string): string | null {
  return httpUrl(value) === null ? null : value;
}

/** Returns an absolute http(s) image URL or a root-relative path, or null. */
export function safeIconUrl(value: string): string | null {
  const icon = value.trim();
  return httpUrl(icon) ?? (isRootRelativeIcon(icon) ? icon : null);
}
