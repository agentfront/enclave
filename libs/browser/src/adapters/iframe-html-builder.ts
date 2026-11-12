/**
 * Iframe HTML Builder
 *
 * Generates HTML content for sandboxed iframes with CSP meta tags.
 * Used by the outer and inner iframe bootstraps to create secure srcdoc content.
 *
 * @packageDocumentation
 */

import { sha256Base64 } from '../utils/sha256';

/**
 * Content Security Policy of a frame document.
 *
 * - `default-src 'none'`: no request source the policy governs is allowed (fetch, XHR, WebSocket,
 *   WebTransport, EventSource, beacons, images, styles, media, frames with a URL, workers).
 * - `script-src 'sha256-…'`: the only script that runs is the one this package wrote into the
 *   document, named by its hash. There is no `'unsafe-inline'` and no `'unsafe-eval'`: no other
 *   inline script, no event-handler attribute, no `javascript:` URL, no `eval`, `Function` or
 *   `setTimeout(string)`.
 *
 * A document a frame creates (`srcdoc`, `about:blank`) inherits the policy of its creator, so
 * nothing but the scripts named here runs in any document of the sandbox, and a worker cannot be
 * started at all.
 *
 * @param scriptHashes Hashes of the scripts the document, and the documents it creates, may run
 */
function framePolicy(scriptHashes: readonly string[]): string {
  const sources = scriptHashes.map((hash) => `'sha256-${hash}'`).join(' ');
  return `default-src 'none'; script-src ${sources}; style-src 'unsafe-inline'`;
}

/** A frame document and the hash that names its script in a policy */
export interface IframeDocument {
  /** Complete HTML, for `srcdoc` */
  html: string;
  /** SHA-256 of the document's script, base64 */
  scriptHash: string;
}

/**
 * Rewrite the characters of a script that an HTML parser does not pass on as they are: a carriage
 * return (read as a line feed), a NUL character (replaced), and half of a surrogate pair (not
 * representable in the document). Each one becomes text with the same meaning in JavaScript: a
 * line feed for a line ending, an escape inside a string. The text of the script element is then
 * exactly the text that was hashed, in every browser.
 */
function parserNeutralScript(script: string): string {
  return script
    .replace(/\r\n?/g, '\n')
    .replace(/\0/g, '\\x00')
    .replace(/[\uD800-\uDFFF]/gu, (half) => `\\u${half.charCodeAt(0).toString(16).toUpperCase()}`);
}

/**
 * Build a complete HTML document for use in iframe srcdoc
 *
 * @param scriptContent - JavaScript code to embed in a <script> tag. It must not hold `</script`
 *   or `<!--`: the callers escape both in everything they embed.
 * @param options - Additional options
 * @returns The document and the hash of its script
 * @throws Error if the script would change how the document around it is read
 */
export function buildIframeDocument(
  scriptContent: string,
  options?: {
    /** Title for the document */
    title?: string;
    /** Hashes of the scripts of the documents this one creates: they inherit its policy */
    childScriptHashes?: readonly string[];
  },
): IframeDocument {
  const script = parserNeutralScript(scriptContent);
  // Either sequence changes where the parser ends the script element. A frame whose script is not
  // the text that was written does not start.
  if (/<\/script|<!--/i.test(script)) {
    throw new Error('The script of a sandbox frame holds text that would end or hide its script element');
  }

  const scriptHash = sha256Base64(script);
  const csp = framePolicy([scriptHash, ...(options?.childScriptHashes ?? [])]);
  const title = options?.title ?? 'Enclave Sandbox';

  const html =
    '<!DOCTYPE html>' +
    '<html><head>' +
    `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttr(csp)}">` +
    `<title>${escapeHtml(title)}</title>` +
    '</head><body>' +
    `<script>${script}</script>` +
    '</body></html>';
  return { html, scriptHash };
}

/**
 * Escape a string for safe use in an HTML attribute value
 */
function escapeHtmlAttr(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Escape a string for safe use in HTML text content
 */
function escapeHtml(str: string): string {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Escape, in JavaScript source that will be the text of a `<script>` element, the two sequences
 * that mean something to the HTML parser there: `</` (the end tag) and `<!--` (which changes how
 * the parser reads the text after it). Inside a string or a template literal the result reads the
 * same: `\/` is `/` and `\!` is `!`.
 */
export function escapeScriptText(source: string): string {
  return source.replace(/<\//g, '<\\/').replace(/<!--/g, '<\\!--');
}

/**
 * JSON.stringify with HTML-safe escaping for embedding in <script> tags.
 *
 * Prevents `</script>` breakout and `<!--` HTML comment injection
 * from any JSON-serialized value.
 */
export function safeJsonStringify(value: unknown): string {
  return escapeScriptText(JSON.stringify(value));
}

/**
 * Escape a string for safe embedding inside a JavaScript string literal
 * within an HTML <script> tag.
 *
 * Handles:
 * - </script> injection (script tag breakout)
 * - Backslash escaping
 * - Newlines, carriage returns
 * - Null bytes
 * - Unicode line/paragraph separators
 */
export function escapeForScriptEmbed(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\0/g, '\\0')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029')
    .replace(/<\/script>/gi, '<\\/script>');
}

/**
 * Get the iframe sandbox attribute value
 * Only allow-scripts is enabled — NO allow-same-origin
 */
export const IFRAME_SANDBOX = 'allow-scripts';
