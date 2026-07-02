/**
 * Autonomy levels — the single dimension that governs how far an action may
 * travel toward an outward effect.
 *
 * ```
 * Observe  →  Shadow  →  Draft  →  Autonomous
 *  watch      predict    prepare    execute
 * ```
 *
 * The ordering is total and meaningful: a higher level permits strictly more
 * than a lower one. The runtime's central safety property is that the
 * *effective* autonomy of an action is the minimum (most restrictive) of what
 * was requested and what every applicable policy allows — policies can only
 * ever lower this value, never raise it. See {@link minAutonomy}.
 */

/** The four autonomy levels, from most to least restrictive. */
export const AutonomyLevel = {
  /** Watch only. Nothing is rendered, nothing is executed. */
  Observe: "observe",
  /** Render a faithful prediction of the effect. Never execute. */
  Shadow: "shadow",
  /** Prepare the effect and hold it as an approval. Execute only once approved. */
  Draft: "draft",
  /** Execute directly, subject to policy and gate checks. */
  Autonomous: "autonomous"
} as const;

export type AutonomyLevel = (typeof AutonomyLevel)[keyof typeof AutonomyLevel];

/** Rank of each level; higher means more permissive. */
const RANK: Record<AutonomyLevel, number> = {
  [AutonomyLevel.Observe]: 0,
  [AutonomyLevel.Shadow]: 1,
  [AutonomyLevel.Draft]: 2,
  [AutonomyLevel.Autonomous]: 3
};

/** All levels, ordered most-restrictive first. */
export const ALL_AUTONOMY_LEVELS: readonly AutonomyLevel[] = [
  AutonomyLevel.Observe,
  AutonomyLevel.Shadow,
  AutonomyLevel.Draft,
  AutonomyLevel.Autonomous
];

/** Numeric rank of a level (Observe = 0 … Autonomous = 3). */
export function autonomyRank(level: AutonomyLevel): number {
  return RANK[level];
}

/** The more restrictive (lower-ranked) of two levels. */
export function minAutonomy(a: AutonomyLevel, b: AutonomyLevel): AutonomyLevel {
  return RANK[a] <= RANK[b] ? a : b;
}

/** True if `a` is at least as permissive as `b`. */
export function autonomyAtLeast(a: AutonomyLevel, b: AutonomyLevel): boolean {
  return RANK[a] >= RANK[b];
}

/** Reduce a list of levels to the most restrictive. Empty list → `Observe`. */
export function mostRestrictive(levels: readonly AutonomyLevel[]): AutonomyLevel {
  return levels.reduce<AutonomyLevel>((acc, level) => minAutonomy(acc, level), AutonomyLevel.Autonomous);
}
