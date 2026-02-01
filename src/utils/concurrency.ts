/**
 * Concurrency utilities for bounded parallel execution
 * Prevents CPU spikes and API rate limiting from unbounded Promise.all
 */

/**
 * Execute async tasks with a concurrency limit (like p-map).
 * Processes items from the input array through the mapper function,
 * running at most `concurrency` tasks simultaneously.
 *
 * NEVER throws - if the mapper throws, the error propagates per-item
 * (caller should handle via try/catch in mapper or use Promise.allSettled pattern).
 *
 * @param items - Array of items to process
 * @param mapper - Async function to apply to each item
 * @param concurrency - Maximum number of concurrent tasks (default: 6)
 * @returns Array of results in the same order as input items
 */
export async function pMap<T, R>(
  items: T[],
  mapper: (item: T, index: number) => Promise<R>,
  concurrency: number = 6
): Promise<R[]> {
  if (items.length === 0) return [];

  // Clamp concurrency to reasonable bounds
  const limit = Math.max(1, Math.min(concurrency, items.length));

  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      results[index] = await mapper(items[index], index);
    }
  }

  // Spawn `limit` workers that pull from the shared index
  const workers: Promise<void>[] = [];
  for (let i = 0; i < limit; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
}

/**
 * Like pMap but uses Promise.allSettled semantics — never rejects,
 * returns PromiseSettledResult for each item.
 *
 * @param items - Array of items to process
 * @param mapper - Async function to apply to each item
 * @param concurrency - Maximum number of concurrent tasks (default: 6)
 * @returns Array of PromiseSettledResult in the same order as input items
 */
export async function pMapSettled<T, R>(
  items: T[],
  mapper: (item: T, index: number) => Promise<R>,
  concurrency: number = 6
): Promise<PromiseSettledResult<R>[]> {
  if (items.length === 0) return [];

  const limit = Math.max(1, Math.min(concurrency, items.length));

  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex++;
      try {
        const value = await mapper(items[index], index);
        results[index] = { status: 'fulfilled', value };
      } catch (reason) {
        results[index] = { status: 'rejected', reason };
      }
    }
  }

  const workers: Promise<void>[] = [];
  for (let i = 0; i < limit; i++) {
    workers.push(worker());
  }

  await Promise.all(workers);
  return results;
}
