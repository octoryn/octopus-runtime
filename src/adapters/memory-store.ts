/**
 * In-memory {@link Store}. The default persistence adapter — zero setup, ideal
 * for local runs and tests. A run's embedded `results` array is the single
 * source of truth for per-action state, so a later draft execution updates it
 * in place.
 */

import type { Store } from "../ports.js";
import type { ExecutionResult, RunRecord } from "../types.js";

export class MemoryStore implements Store {
  readonly #runs = new Map<string, RunRecord>();

  async saveRun(run: RunRecord): Promise<void> {
    this.#runs.set(run.id, clone(run));
  }

  async getRun(runId: string): Promise<RunRecord | undefined> {
    const run = this.#runs.get(runId);
    return run ? clone(run) : undefined;
  }

  async listRuns(): Promise<RunRecord[]> {
    return [...this.#runs.values()].map(clone);
  }

  async saveResult(result: ExecutionResult): Promise<void> {
    const run = this.#runs.get(result.runId);
    if (!run) return;
    const idx = run.results.findIndex((r) => r.actionRef === result.actionRef);
    if (idx >= 0) run.results[idx] = clone(result);
    else run.results.push(clone(result));
  }

  async getResult(runId: string, actionRef: string): Promise<ExecutionResult | undefined> {
    const run = this.#runs.get(runId);
    const result = run?.results.find((r) => r.actionRef === actionRef);
    return result ? clone(result) : undefined;
  }
}

/** Deep clone so stored state cannot be mutated by callers holding a reference. */
function clone<T>(value: T): T {
  return structuredClone(value);
}
