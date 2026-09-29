export class HostQueue {
  #tail: Promise<void> = Promise.resolve();
  #pending = 0;

  get pending(): number {
    return this.#pending;
  }

  enqueue<T>(operation: () => T | Promise<T>): Promise<T> {
    this.#pending += 1;
    const result = this.#tail.then(operation);
    this.#tail = result.then(
      () => {
        this.#pending -= 1;
      },
      () => {
        this.#pending -= 1;
      },
    );
    return result;
  }

  async drain(): Promise<void> {
    let observedTail: Promise<void>;
    do {
      observedTail = this.#tail;
      await observedTail;
    } while (observedTail !== this.#tail);
  }
}
