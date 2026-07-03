import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

/**
 * Mission invariant: this runtime has ZERO compile-time dependency on the
 * surrounding operating system. This test mechanically enforces that no source
 * file imports any forbidden system, so the boundary cannot erode by accident.
 */

const FORBIDDEN = ["octopus-blackboard", "octopus-experience", "signalsos", "signals-os", "observe"];

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src");

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...tsFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

test("no source file imports a forbidden surrounding system", () => {
  const importRe = /\b(?:import|export)\b[^;]*?\bfrom\s+["']([^"']+)["']/g;
  const offenders: string[] = [];

  for (const file of tsFiles(srcDir)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(importRe)) {
      const specifier = (match[1] ?? "").toLowerCase();
      if (FORBIDDEN.some((f) => specifier.includes(f))) {
        offenders.push(`${file}: imports "${match[1]}"`);
      }
    }
  }

  assert.deepEqual(offenders, [], `forbidden imports found:\n${offenders.join("\n")}`);
});

test("the runtime declares zero third-party runtime dependencies", () => {
  const pkgPath = join(srcDir, "..", "package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as {
    dependencies?: Record<string, string>;
  };
  // The only permitted runtime dependency is the first-party octopus-evidence
  // primitive (itself zero-dependency), which provides the canonical hashing and
  // tamper-evident Evidence the whole stack shares. Everything else stays out.
  const deps = Object.keys(pkg.dependencies ?? {});
  assert.deepEqual(
    deps,
    ["octopus-evidence"],
    "core must stay third-party-dependency-free; the only allowed runtime dependency is octopus-evidence"
  );
});
