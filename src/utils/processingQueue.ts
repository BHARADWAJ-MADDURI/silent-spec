type QueueTask = () => Promise<void>;

class ProcessingQueue {
  private queue: QueueTask[] = [];
  private running = false;

  enqueue(task: QueueTask): void {
    this.queue.push(task);
    if (!this.running) {
      void this.drain();
    }
  }

  private async drain(): Promise<void> {
    this.running = true;
    while (this.queue.length > 0) {
      const task = this.queue.shift()!;
      try {
        await task();
      } catch (error: unknown) {
        // Task failed — log and continue draining
        // Never let one file's failure kill the queue
        const msg = error instanceof Error ? error.message : String(error);
        console.error(`SilentSpec: queue task failed — ${msg}`);
      }
    }
    this.running = false;
  }
}

export const processingQueue = new ProcessingQueue();