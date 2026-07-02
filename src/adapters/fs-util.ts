/**
 * Shared filesystem helpers for the durable adapters. Internal — not part of
 * the public API.
 *
 * Writes are atomic (write a temp file, then rename over the target), so a
 * crash mid-write never leaves a partially written record. Reads treat a
 * missing file as "not found" rather than an error.
 */

import { readFile, writeFile, rename } from "node:fs/promises";

/** Read and parse a JSON file; returns `undefined` if it does not exist. */
export async function readJson<T>(path: string): Promise<T | undefined> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw err;
  }
}

/** Atomically write `value` as JSON to `path` (temp file + rename). */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.tmp`;
  await writeFile(tmp, JSON.stringify(value), "utf8");
  await rename(tmp, path);
}

/**
 * Serializes async operations per key so read-modify-write sequences on the
 * same record cannot interleave within a process. (Cross-process locking is out
 * of scope for the file adapters; a single runtime owns its data directory.)
 */
export class KeyedLock {
  readonly #tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.#tails.get(key) ?? Promise.resolve();
    const result = prev.then(() => fn());
    const guarded = result.catch(() => undefined);
    this.#tails.set(key, guarded);
    void guarded.then(() => {
      if (this.#tails.get(key) === guarded) this.#tails.delete(key);
    });
    return result;
  }
}
