export type AbuseReportCategory =
  | "csam"
  | "extreme_violence"
  | "self_harm"
  | "hate_speech"
  | "harassment"
  | "copyright_infringement"
  | "spam_or_abuse"
  | "other";

export type ModerationQueueStatus = "PENDING_REVIEW" | "ACTIONED" | "DISMISSED";

export type ModerationAction = "DISMISS" | "HIDE_CONTENT" | "SUSPEND_USER" | "WARN_USER";

export interface AbuseReportInput {
  targetType: "JOB" | "ASSET" | "USER";
  targetId: string;
  category: AbuseReportCategory;
  details: string;
  reporterEmail?: string;
}

export interface ModerationAuditEntry {
  timestamp: string;
  operatorId: string;
  action: ModerationAction;
  reason: string;
  previousStatus: ModerationQueueStatus;
  newStatus: ModerationQueueStatus;
}

export interface ModerationItem {
  id: string;
  targetType: "JOB" | "ASSET" | "USER";
  targetId: string;
  category: AbuseReportCategory;
  details: string;
  status: ModerationQueueStatus;
  reporterId: string | null;
  reportedAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
  resolutionNotes?: string;
  actionTaken?: ModerationAction;
  auditHistory: ModerationAuditEntry[];
  targetExcerpt?: string;
}

export interface ActionModerationInput {
  reportId: string;
  action: ModerationAction;
  operatorId: string;
  notes: string;
}
