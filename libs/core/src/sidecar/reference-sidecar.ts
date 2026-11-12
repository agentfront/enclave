/**
 * Reference Sidecar - Request-scoped storage for lifted data
 *
 * The Reference Sidecar is a key-value store that holds large data
 * outside the JavaScript sandbox. Scripts interact with reference IDs
 * instead of actual data, and references are resolved at the callTool boundary.
 *
 * @packageDocumentation
 */

import { randomUUID } from 'crypto';
import {
  ReferenceConfig,
  REF_ID_PREFIX,
  REF_ID_SUFFIX,
  isReferenceId,
  getMaxTotalResolvedSize,
} from './reference-config';

/**
 * Source of a stored reference
 */
export type ReferenceSource = 'extraction' | 'tool-result';

/**
 * Metadata for a stored reference
 */
export interface ReferenceMetadata {
  /**
   * When the reference was created
   */
  createdAt: number;

  /**
   * Size of the data in bytes
   */
  size: number;

  /**
   * Source of the reference (extraction from code or tool result)
   */
  source: ReferenceSource;

  /**
   * Optional MIME type hint
   */
  mimeType?: string;

  /**
   * Optional origin (tool name that created it)
   */
  origin?: string;
}

/**
 * Error thrown when sidecar limits are exceeded
 */
export class SidecarLimitError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly limit: number,
    public readonly current: number,
  ) {
    super(message);
    this.name = 'SidecarLimitError';
    Object.setPrototypeOf(this, SidecarLimitError.prototype);
  }
}

/**
 * Error thrown when a reference is not found
 */
export class ReferenceNotFoundError extends Error {
  constructor(public readonly refId: string) {
    super(`Reference not found: ${refId}`);
    this.name = 'ReferenceNotFoundError';
    Object.setPrototypeOf(this, ReferenceNotFoundError.prototype);
  }
}

/**
 * Request-scoped reference storage
 *
 * Stores large data outside the sandbox and provides opaque reference IDs.
 * Must be disposed after each execution to prevent memory leaks.
 *
 * @example
 * ```typescript
 * const sidecar = new ReferenceSidecar(REFERENCE_CONFIGS.STRICT);
 *
 * // Store large data
 * const refId = sidecar.store(largeBuffer, 'extraction');
 *
 * // Later, retrieve it
 * const data = sidecar.retrieve(refId);
 *
 * // Always dispose after execution
 * sidecar.dispose();
 * ```
 */
export class ReferenceSidecar {
  private readonly storage = new Map<string, Buffer>();
  private readonly metadata = new Map<string, ReferenceMetadata>();
  /** The stored values that were resolved for a tool call, as the string they were resolved to */
  private readonly resolved = new Map<string, string>();
  private totalSize = 0;
  /** Bytes of resolved data built for the tool calls of this execution so far */
  private resolvedSize = 0;
  private readonly maxTotalResolvedSize: number;
  private disposed = false;

  constructor(private readonly config: ReferenceConfig) {
    this.maxTotalResolvedSize = getMaxTotalResolvedSize(config);
  }

  /**
   * Store data and return a reference ID
   *
   * @param data - The data to store (string or Buffer)
   * @param source - Where this data came from
   * @param options - Optional metadata
   * @returns The reference ID (format: __REF_uuid__)
   * @throws SidecarLimitError if limits are exceeded
   */
  store(data: string | Buffer, source: ReferenceSource, options?: { mimeType?: string; origin?: string }): string {
    if (this.disposed) {
      throw new Error('Cannot store: sidecar has been disposed');
    }

    // Convert string to Buffer
    const buffer = typeof data === 'string' ? Buffer.from(data, 'utf-8') : data;
    const size = buffer.length;

    // Check reference count limit
    if (this.storage.size >= this.config.maxReferenceCount) {
      throw new SidecarLimitError(
        `Maximum reference count exceeded (${this.config.maxReferenceCount})`,
        'MAX_REFERENCE_COUNT',
        this.config.maxReferenceCount,
        this.storage.size,
      );
    }

    // Check single reference size limit
    if (size > this.config.maxReferenceSize) {
      throw new SidecarLimitError(
        `Reference size ${size} bytes exceeds maximum ${this.config.maxReferenceSize} bytes`,
        'MAX_REFERENCE_SIZE',
        this.config.maxReferenceSize,
        size,
      );
    }

    // Check total size limit
    if (this.totalSize + size > this.config.maxTotalSize) {
      throw new SidecarLimitError(
        `Total sidecar size would exceed maximum: ${this.totalSize + size} > ${this.config.maxTotalSize}`,
        'MAX_TOTAL_SIZE',
        this.config.maxTotalSize,
        this.totalSize + size,
      );
    }

    // Generate cryptographically secure reference ID
    const refId = `${REF_ID_PREFIX}${randomUUID()}${REF_ID_SUFFIX}`;

    // Store with defensive copy (prevent external mutations)
    this.storage.set(refId, Buffer.from(buffer));
    this.totalSize += size;

    // Store metadata
    this.metadata.set(refId, {
      createdAt: Date.now(),
      size,
      source,
      mimeType: options?.mimeType,
      origin: options?.origin,
    });

    return refId;
  }

  /**
   * Retrieve data by reference ID
   *
   * @param refId - The reference ID to look up
   * @returns The stored data or undefined if not found
   */
  retrieve(refId: string): Buffer | undefined {
    if (this.disposed) {
      return undefined;
    }

    const data = this.storage.get(refId);
    // Return defensive copy to prevent external mutations
    return data ? Buffer.from(data) : undefined;
  }

  /**
   * Retrieve data as a string
   *
   * @param refId - The reference ID to look up
   * @param encoding - String encoding (default: utf-8)
   * @returns The stored data as a string or undefined
   */
  retrieveString(refId: string, encoding: BufferEncoding = 'utf-8'): string | undefined {
    const data = this.retrieve(refId);
    return data?.toString(encoding);
  }

  /**
   * Resolve a reference for a tool call: the stored data as a string
   *
   * A stored value is decoded once in the life of the sidecar (one execution) and counted
   * against `maxTotalResolvedSize` then. Every later resolution, in the same call or in another,
   * returns the same string and counts nothing: a string cannot be changed, so handing it out
   * again takes no memory.
   *
   * @param refId - The reference ID to resolve
   * @returns The stored data as a string, or undefined if the reference is not known
   * @throws SidecarLimitError if the execution's total of resolved data would be exceeded
   */
  resolveString(refId: string): string | undefined {
    if (this.disposed) {
      return undefined;
    }

    const known = this.resolved.get(refId);
    if (known !== undefined) {
      return known;
    }

    const data = this.storage.get(refId);
    if (data === undefined) {
      return undefined;
    }

    this.countResolved(data.length);
    const text = data.toString('utf-8');
    this.resolved.set(refId, text);
    return text;
  }

  /**
   * Whether a reference was resolved before, so that resolving it again counts nothing
   */
  isResolved(refId: string): boolean {
    return !this.disposed && this.resolved.has(refId);
  }

  /**
   * Count resolved data that is about to be built for a tool call of this execution
   *
   * @param bytes - Size of the data in bytes
   * @throws SidecarLimitError if the total would exceed `maxTotalResolvedSize`; nothing is counted then
   */
  countResolved(bytes: number): void {
    if (!this.canResolve(bytes)) {
      throw new SidecarLimitError(
        `Total resolved size would exceed maximum: ${this.resolvedSize + bytes} > ${this.maxTotalResolvedSize}`,
        'MAX_TOTAL_RESOLVED_SIZE',
        this.maxTotalResolvedSize,
        this.resolvedSize + bytes,
      );
    }
    this.resolvedSize += bytes;
  }

  /**
   * Whether `bytes` more of resolved data fit in what this execution may resolve in total
   */
  canResolve(bytes: number): boolean {
    return bytes >= 0 && this.resolvedSize + bytes <= this.maxTotalResolvedSize;
  }

  /**
   * Bytes of resolved data built for the tool calls of this execution so far
   */
  getResolvedSize(): number {
    return this.resolvedSize;
  }

  /**
   * Check if a reference ID exists
   */
  has(refId: string): boolean {
    return !this.disposed && this.storage.has(refId);
  }

  /**
   * Get metadata for a reference
   */
  getMetadata(refId: string): ReferenceMetadata | undefined {
    if (this.disposed) {
      return undefined;
    }
    return this.metadata.get(refId);
  }

  /**
   * Get the size of a reference without retrieving data
   */
  getSize(refId: string): number | undefined {
    return this.getMetadata(refId)?.size;
  }

  /**
   * Get total size of all stored references
   */
  getTotalSize(): number {
    return this.totalSize;
  }

  /**
   * Get number of stored references
   */
  getCount(): number {
    return this.storage.size;
  }

  /**
   * Get the configuration
   */
  getConfig(): ReferenceConfig {
    return { ...this.config };
  }

  /**
   * Check if a value is a reference ID
   */
  isReference(value: unknown): value is string {
    return isReferenceId(value);
  }

  /**
   * Get all reference IDs (for debugging/auditing)
   */
  getAllReferenceIds(): string[] {
    return Array.from(this.storage.keys());
  }

  /**
   * Get audit log of all stored references
   */
  getAuditLog(): Array<{ refId: string; metadata: ReferenceMetadata }> {
    const log: Array<{ refId: string; metadata: ReferenceMetadata }> = [];
    for (const [refId, metadata] of this.metadata) {
      log.push({ refId, metadata });
    }
    return log;
  }

  /**
   * Check if the sidecar has been disposed
   */
  isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Dispose the sidecar and release all memory
   *
   * MUST be called after each execution to prevent memory leaks.
   * After disposal, the sidecar cannot be used.
   */
  dispose(): void {
    if (this.disposed) {
      return;
    }

    this.storage.clear();
    this.metadata.clear();
    this.resolved.clear();
    this.totalSize = 0;
    this.disposed = true;
  }
}
