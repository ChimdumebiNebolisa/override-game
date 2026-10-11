/** Inserts opt in explicitly; schema/migration defaults always describe legacy records. */
export const NEW_MATCH_POLICY = {
  version: 2,
  decisionMs: 10_000,
  revealMs: 3_000,
} as const;

export function usesReview(row: { policy_version: number; progression: string }): boolean {
  return row.policy_version === NEW_MATCH_POLICY.version && row.progression === 'review';
}
