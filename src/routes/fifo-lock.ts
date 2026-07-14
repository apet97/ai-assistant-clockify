/** Small keyed FIFO used to serialize one admin session's mutation flows. */
export class KeyedFifo {
  private readonly tails = new Map<string, Promise<void>>();

  async run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const predecessor = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const current = predecessor.catch(() => undefined).then(() => gate);
    this.tails.set(key, current);
    await predecessor.catch(() => undefined);
    try {
      return await task();
    } finally {
      release();
      if (this.tails.get(key) === current) this.tails.delete(key);
    }
  }
}
