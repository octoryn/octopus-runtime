/**
 * Durable, file-backed {@link Store}. Survives process restarts with no native
 * dependencies and no database — one JSON file per run, written atomically.
 *
 * An event-pointer file (`events/<key>.json`) maps a workflow + trigger event
 * id to its run id, so idempotent ingestion ({@link findRunByEvent}) is an O(1)
 * lookup rather than a directory scan.
 *
 * Scope: a single runtime process owns its data directory. In-process writes to
 * the same run are serialized; cross-process coordination is out of scope.
 *
 * Durability note: the run file and its event-pointer are two separate atomic
 * writes. A crash between them leaves a run with no pointer, so on restart a
 * redelivery of that event is treated as new and the workflow runs again. This
 * is why exactly-once *effects* rely on the connector honoring the stable
 * `idempotencyKey` (derived from workflow + event + action), not on ingestion
 * dedup alone — ingestion dedup is a best-effort optimization across crashes.
 */

import { mkdirSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { Buffer } from "node:buffer";
import type { Store } from "../ports.js";
import type { ExecutionResult, RunRecord } from "../types.js";
import { readJson, writeJsonAtomic, KeyedLock } from "./fs-util.js";
import { compositeKey } from "../ids.js";

export class FileStore implements Store {
  readonly #runsDir: string;
  readonly #eventsDir: string;
  readonly #locks = new KeyedLock();

  constructor(dir: string) {
    this.#runsDir = join(dir, "runs");
    this.#eventsDir = join(dir, "events");
    mkdirSync(this.#runsDir, { recursive: true });
    mkdirSync(this.#eventsDir, { recursive: true });
  }

  async saveRun(run: RunRecord): Promise<void> {
    await this.#locks.run(run.id, async () => {
      await writeJsonAtomic(this.#runPath(run.id), run);
      await writeJsonAtomic(this.#eventPath(run.workflowId, run.event.id), { runId: run.id });
    });
  }

  getRun(runId: string): Promise<RunRecord | undefined> {
    return readJson<RunRecord>(this.#runPath(runId));
  }

  async listRuns(): Promise<RunRecord[]> {
    const files = await readdir(this.#runsDir).catch(() => [] as string[]);
    const runs: RunRecord[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      const run = await readJson<RunRecord>(join(this.#runsDir, file));
      if (run) runs.push(run);
    }
    return runs;
  }

  async saveResult(result: ExecutionResult): Promise<void> {
    await this.#locks.run(result.runId, async () => {
      const run = await readJson<RunRecord>(this.#runPath(result.runId));
      if (!run) return;
      const idx = run.results.findIndex((r) => r.actionRef === result.actionRef);
      if (idx >= 0) run.results[idx] = result;
      else run.results.push(result);
      await writeJsonAtomic(this.#runPath(result.runId), run);
    });
  }

  async getResult(runId: string, actionRef: string): Promise<ExecutionResult | undefined> {
    const run = await this.getRun(runId);
    return run?.results.find((r) => r.actionRef === actionRef);
  }

  async findRunByEvent(workflowId: string, eventId: string): Promise<RunRecord | undefined> {
    const pointer = await readJson<{ runId: string }>(this.#eventPath(workflowId, eventId));
    if (!pointer) return undefined;
    return this.getRun(pointer.runId);
  }

  #runPath(runId: string): string {
    return join(this.#runsDir, `${encodeName(runId)}.json`);
  }

  #eventPath(workflowId: string, eventId: string): string {
    const key = Buffer.from(compositeKey(workflowId, eventId)).toString("base64url");
    return join(this.#eventsDir, `${key}.json`);
  }
}

/** Encode an id into a filesystem-safe filename component. */
function encodeName(id: string): string {
  return Buffer.from(id).toString("base64url");
}
