/**
 * Verification failure reasons, as emitted by the API, paired with a plain
 * explanation and the action that actually resolves each one.
 *
 * Every value here is DATA. Nothing in this table is phrased as an instruction,
 * because an agent reads it and must not treat it as something to obey.
 */
export interface ReasonExplanation {
  reason: string;
  meaning: string;
  /** Who can do something about it. */
  actor: "end_user" | "integrator" | "nobody";
  fix: string;
  retryable: boolean;
}

const TABLE: Record<string, Omit<ReasonExplanation, "reason">> = {
  age_below_threshold: {
    meaning: "The subject's verified age is below the gate configured for this API key.",
    actor: "nobody",
    fix: "This is a correct refusal, not an error. Do not retry and do not attempt to override it.",
    retryable: false,
  },
  liveness_failed: {
    meaning: "The liveness challenge did not pass — the capture may have been a photo, a screen, or an incomplete set of movements.",
    actor: "end_user",
    fix: "Have the subject retry in even lighting, following the on-screen arrows to completion.",
    retryable: true,
  },
  face_mismatch: {
    meaning: "The selfie did not match the face on the submitted document.",
    actor: "end_user",
    fix: "Have the subject retake both captures. Persistent mismatch on a genuine document warrants manual review.",
    retryable: true,
  },
  document_rejected: {
    meaning: "The document could not be accepted — unsupported type, unreadable capture, or failed authenticity checks.",
    actor: "end_user",
    fix: "Have the subject retake the document capture, filling the frame, with no glare and all corners visible.",
    retryable: true,
  },
  dob_unreadable: {
    meaning: "The document was read but the date of birth could not be extracted with confidence.",
    actor: "end_user",
    fix: "Have the subject retake the document capture at higher resolution, ensuring the data page is flat and in focus.",
    retryable: true,
  },
  blacklist_match: {
    meaning: "The face matched an entry on this tenant's fraud blacklist.",
    actor: "nobody",
    fix: "This is a deliberate refusal. Blacklist entries are managed by your staff in the dashboard, never automatically.",
    retryable: false,
  },
};

/** Explain a reason code. Unknown codes return a safe, honest fallback. */
export function explainReason(reason: string): ReasonExplanation {
  const entry = TABLE[reason];
  if (!entry) {
    return {
      reason,
      meaning: "This reason code is not in the local table, which may mean the server is newer than this package.",
      actor: "integrator",
      fix: "Check the changelog at https://docs.xident.io/changelog, and upgrade this package.",
      retryable: false,
    };
  }
  return { reason, ...entry };
}

/** Every reason this package can explain. */
export function knownReasons(): string[] {
  return Object.keys(TABLE).sort();
}
