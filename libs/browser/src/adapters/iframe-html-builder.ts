/**
 * Iframe HTML Builder
 *
 * Generates HTML content for sandboxed iframes with CSP meta tags.
 * Used by the outer and inner iframe bootstraps to create secure srcdoc content.
 *
 * @packageDocumentation
 */

/**
 * Content Security Policy for sandboxed iframes
 *
 * - default-src 'none': Blocks all network (fetch, XHR, WebSocket, images)
 * - script-src 'unsafe-inline': Allows inline <script> but blocks eval/Function/setTimeout(string)
 * - No 'unsafe-eval': Equivalent to VM's codeGeneration: { strings: false, wasm: false }
 */
const IFRAME_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'";

/**
 * Build a complete HTML document for use in iframe srcdoc
 *
 * @param scriptContent - JavaScript code to embed in a <script> tag
 * @param options - Additional options
 * @returns Complete HTML string suitable for srcdoc
 */
export function buildIframeHtml(
  scriptContent: string,
  options?: {
    /** Additional CSP directives to append */
    extraCsp?: string;
    /** Title for the document */
    title?: string;
  },
): string {
  const csp = options?.extraCsp ? `${IFRAME_CSP}; ${options.extraCsp}` : IFRAME_CSP;
  const title = options?.title ?? 'Enclave Sandbox';

  return (
    '<!DOCTYPE html>' +
    '<html><head>' +
    `<meta http-equiv="Content-Security-Policy" content="${escapeHtmlAttr(csp)}">` +
    `<title>${escapeHtml(title)}</title>` +
    '</head><body>' +
    `<script>${scriptContent}</script>` +
    '</body></html>'
  );
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
