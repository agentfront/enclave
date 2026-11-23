import type { ReferenceEntry, ReferenceSidecar } from './sidecar/reference-sidecar';
import type { ExecutionResult } from './types';

/** The run options that carry references from one run to a later one (with the sidecar) */
export interface KeptReferenceOptions {
  /** Entries an earlier run exported: they resolve at the tool boundary and count toward this run's limits */
  preloadReferences?: readonly ReferenceEntry[];
  /** Called with the returned value once the run is over: the tokens whose entries go to `result.references` */
  exportReferences?: (value: unknown) => Iterable<string>;
}

/** @throws TypeError when the options ask for references without a sidecar, or `exportReferences` is not a function */
export function assertKeptReferenceOptions(options: KeptReferenceOptions, hasSidecar: boolean): void {
  const { preloadReferences, exportReferences } = options;
  if ((preloadReferences !== undefined || exportReferences !== undefined) && !hasSidecar) {
    throw new TypeError('preloadReferences and exportReferences need the sidecar option');
  }
  if (exportReferences !== undefined && typeof exportReferences !== 'function') {
    throw new TypeError('exportReferences must be a function');
  }
}

/** Run with the sidecar of the run: preloaded first, exported from at the end, disposed whatever happens */
export async function withKeptReferences<T>(
  sidecar: ReferenceSidecar | undefined,
  options: KeptReferenceOptions,
  execute: () => Promise<ExecutionResult<T>>,
): Promise<ExecutionResult<T>> {
  try {
    if (sidecar && options.preloadReferences) sidecar.preload(options.preloadReferences);
    const result = await execute();
    if (!sidecar || !options.exportReferences) return result;
    return { ...result, references: sidecar.exportEntries(options.exportReferences(result.value)) };
  } finally {
    sidecar?.dispose();
  }
}
