type QueueTask = () => Promise<void>;

class ProcessingQueue {
  private queue: QueueTask[] = [];
  private running = false;
  // Optional channel logger set by extension.ts after activation.
  // Falls back to console.error so the backstop always fires even before wiring.
  private errorLog: ((msg: string) => void) | null = null;

  /** Wire up the output-channel logger once the extension activates. */
  setErrorLogger(fn: (msg: string) => void): void {
    this.errorLog = fn;
  }

  enqueue(task: QueueTask): void {
    this.queue.push(task);
    if (!this.running) {
      void this.drain();
    }
  }

  get size(): number {
  return this.queue.length + (this.running ? 1 : 0);
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      while (this.queue.length > 0) {
        const task = this.queue.shift()!;
        try {
          await task();
        } catch (error: unknown) {
          // Task failed — log and continue draining
          // Never let one file's failure kill the queue
          const msg = error instanceof Error ? error.message : String(error);
          // H1 fix: surface to the SilentSpec output channel (visible to users),
          // not just the hidden developer console.
          console.error(`SilentSpec: queue task failed — ${msg}`);
          this.errorLog?.(`Queue task failed unexpectedly — ${msg}`);
        }
      }
    } finally {
      this.running = false;
    }
  }
}

export const processingQueue = new ProcessingQueue();
