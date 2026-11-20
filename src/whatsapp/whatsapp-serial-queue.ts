/** One async job at a time per key (phone). Later jobs wait; a failure does not skip the rest. */
export class SerialQueue {
  private tails = new Map<string, Promise<void>>();

  enqueue(key: string, fn: () => Promise<void>, onError?: (error: unknown) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const prev = this.tails.get(key) ?? Promise.resolve();
      const next = prev
        .then(fn)
        .then(() => {
          resolve();
        })
        .catch((error) => {
          onError?.(error);
          reject(error);
        });
      this.tails.set(
        key,
        next.catch(() => undefined),
      );
    });
  }
}
