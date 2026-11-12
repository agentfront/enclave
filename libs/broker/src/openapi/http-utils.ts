/**
 * HTTP helpers of the OpenAPI integration
 *
 * What the broker reads from a specification host or an upstream is bounded in size, and the
 * headers the embedder configured for one origin are not sent to another.
 *
 * @packageDocumentation
 */

/**
 * Redirects followed for one request.
 */
const MAX_REDIRECTS = 5;

const REDIRECT_STATUS = [301, 302, 303, 307, 308];

/**
 * A response body is larger than the limit it is read with.
 */
export class ResponseTooLargeError extends Error {
  readonly code = 'RESPONSE_TOO_LARGE';

  constructor(maxBytes: number) {
    super(`Response body exceeds the limit of ${maxBytes} bytes`);
    this.name = 'ResponseTooLargeError';
  }
}

/**
 * Whether two URLs have the same origin. A URL that cannot be parsed has no origin.
 */
export function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Already closed
  }
}

/**
 * Read a response body as text, up to `maxBytes`. Reading stops at the limit.
 *
 * @param truncate - return what was read up to the limit instead of throwing
 * @throws ResponseTooLargeError when the body is larger and `truncate` is not set
 */
export async function readBodyText(response: Response, maxBytes: number, truncate = false): Promise<string> {
  if (!truncate) {
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > maxBytes) {
      await discard(response);
      throw new ResponseTooLargeError(maxBytes);
    }
  }
  if (!response.body) {
    return '';
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      if (!truncate) {
        throw new ResponseTooLargeError(maxBytes);
      }
      text += decoder.decode(value.subarray(0, value.byteLength - (total - maxBytes)), { stream: true });
      break;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

/**
 * A request with the headers the embedder configured for its origin.
 */
export interface OriginBoundRequest {
  method: string;
  headers: Record<string, string>;
  body?: BodyInit;
  signal?: AbortSignal;
}

/**
 * `fetch` that keeps the request's headers on the origin they were configured for.
 *
 * Redirects are followed here, at most a few. A redirect within the origin of the request is
 * followed with the same headers. A redirect to another origin is followed without them (a
 * content type for a body that is sent again is kept), and they are not restored afterwards.
 */
export async function fetchOriginBound(url: string, request: OriginBoundRequest): Promise<Response> {
  const origin = new URL(url).origin;
  let current = url;
  let method = request.method;
  let body = request.body;
  let headers = request.headers;

  for (let hop = 0; ; hop++) {
    const response = await fetch(current, { method, headers, body, signal: request.signal, redirect: 'manual' });
    const location = REDIRECT_STATUS.includes(response.status) ? response.headers.get('location') : null;
    if (!location) {
      return response;
    }

    await discard(response);
    if (hop >= MAX_REDIRECTS) {
      throw new Error(`Too many redirects (more than ${MAX_REDIRECTS})`);
    }

    let next: URL;
    try {
      next = new URL(location, current);
    } catch {
      throw new Error('Redirect to an invalid URL');
    }
    if (next.protocol !== 'http:' && next.protocol !== 'https:') {
      throw new Error('Redirect to an unsupported URL');
    }

    // The method and the body a redirect is followed with, as `fetch` itself does it
    if (
      (response.status === 303 && method !== 'GET' && method !== 'HEAD') ||
      ((response.status === 301 || response.status === 302) && method === 'POST')
    ) {
      method = 'GET';
      body = undefined;
      headers = withoutContentType(headers);
    }

    if (next.origin !== origin) {
      headers = body === undefined ? {} : onlyContentType(headers);
    }

    current = next.href;
  }
}

function withoutContentType(headers: Record<string, string>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== 'content-type') kept[name] = value;
  }
  return kept;
}

function onlyContentType(headers: Record<string, string>): Record<string, string> {
  const kept: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() === 'content-type') kept[name] = value;
  }
  return kept;
}
