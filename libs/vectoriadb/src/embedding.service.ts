import { EmbeddingError, ConfigurationError } from './errors';

/**
 * Service for generating embeddings using transformers.js
 *
 * NOTE: This service requires @huggingface/transformers to be installed.
 * Install it with: npm install @huggingface/transformers
 *
 * For a zero-dependency alternative, use TFIDFEmbeddingService instead.
 */
export class EmbeddingService {
  // Using 'any' because @huggingface/transformers is an optional dependency
  private pipeline: any = null;
  private modelName: string;
  private cacheDir: string;
  private dimensions = 384; // default for all-MiniLM-L6-v2
  private isInitialized = false;
  private initializationPromise: Promise<void> | null = null;

  constructor(modelName = 'Xenova/all-MiniLM-L6-v2', cacheDir = './.cache/transformers') {
    this.modelName = modelName;
    this.cacheDir = cacheDir;
  }

  /**
   * Dynamically import @huggingface/transformers
   * This allows the package to be optional - only loaded when actually used
   */
  private async loadTransformers(): Promise<any> {
    try {
      // Dynamic import - package may not be installed
      const transformers = await (Function('return import("@huggingface/transformers")')() as Promise<any>);
      return transformers.pipeline;
    } catch (_error) {
      throw new ConfigurationError(
        '@huggingface/transformers is not installed. ' +
          'Install it with: npm install @huggingface/transformers\n' +
          'Or use TFIDFVectoria/TFIDFEmbeddingService for a zero-dependency alternative.',
      );
    }
  }

  /**
   * Initialize the embedding model
   */
  async initialize(): Promise<void> {
    // Prevent multiple initializations
    if (this.isInitialized) {
      return;
    }

    if (this.initializationPromise) {
      return this.initializationPromise;
    }

    this.initializationPromise = this._initialize();
    return this.initializationPromise;
  }

  private async _initialize(): Promise<void> {
    try {
      // Dynamically load transformers
      const pipelineFn = await this.loadTransformers();

      // Create feature extraction pipeline
      this.pipeline = await pipelineFn('feature-extraction', this.modelName, {
        // Use local models directory to cache models
        cache_dir: this.cacheDir,
        // // Don't require progress bars in production
        // progress_callback: null,
      });

      // Test the pipeline to get dimensions
      const testEmbedding = await this.pipeline('test', {
        pooling: 'mean',
        normalize: true,
      });

      this.dimensions = testEmbedding.data.length;
      this.isInitialized = true;
    } catch (error) {
      this.initializationPromise = null;
      if (error instanceof ConfigurationError) {
        throw error;
      }
      throw new EmbeddingError(
        `Failed to initialize embedding model: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Generate embedding for a single text
   */
  async generateEmbedding(text: string): Promise<Float32Array> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
      const output = await this.pipeline(text, {
        pooling: 'mean',
        normalize: true,
      });

      return new Float32Array(output.data);
    } catch (error) {
      throw new EmbeddingError(
        `Failed to generate embedding: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Generate embeddings for multiple texts in batch
   */
  async generateEmbeddings(texts: string[]): Promise<Float32Array[]> {
    if (!this.isInitialized) {
      await this.initialize();
    }

    try {
      // Process in batches to avoid memory issues
      const batchSize = 32;
      const results: Float32Array[] = [];

      for (let i = 0; i < texts.length; i += batchSize) {
        const batch = texts.slice(i, i + batchSize);
        const outputs = await Promise.all(
          batch.map((text) =>
            this.pipeline(text, {
              pooling: 'mean',
              normalize: true,
            }),
          ),
        );

        results.push(...outputs.map((output) => new Float32Array(output.data)));
      }

      return results;
    } catch (error) {
      throw new EmbeddingError(
        `Failed to generate embeddings: ${error instanceof Error ? error.message : String(error)}`,
        error instanceof Error ? error : undefined,
      );
    }
  }

  /**
   * Get the vector dimensions
   */
  getDimensions(): number {
    return this.dimensions;
  }

  /**
   * Get the model name
   */
  getModelName(): string {
    return this.modelName;
  }

  /**
   * Check if the service is initialized
   */
  isReady(): boolean {
    return this.isInitialized;
  }
}
