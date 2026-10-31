import { supabase } from "@/lib/supabase";

export type BulkGenerateSkip = {
  admissionId: string;
  residentName: string;
  reason: string;
};

export type BulkGenerateResult = {
  billingMonth: string;
  createdCount: number;
  skipped: BulkGenerateSkip[];
  activeAdmissionCount: number;
};

export type ApprovalOutcome = {
  billId: string;
  billNumber: string;
  residentName: string;
  approved: boolean;
  emailStatus:
    | "sent"
    | "skipped"
    | "configuration_required"
    | "failed"
    | "not_attempted";
  reason: string | null;
};

export type ApprovalResult = {
  requested: number;
  approvedCount: number;
  emailedCount: number;
  emailConfigurationRequired: boolean;
  outcomes: ApprovalOutcome[];
};

async function accessToken() {
  const { data } = await supabase.auth.getSession();
  if (data.session?.access_token) return data.session.access_token;

  const refreshed = await supabase.auth.refreshSession();
  return refreshed.data.session?.access_token ?? null;
}

async function postJson<T>(endpoint: string, body: object): Promise<T> {
  const token = await accessToken();
  if (!token) {
    throw new Error(
      "Your admin session could not be verified. Please sign in again.",
    );
  }

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body),
  });

  const payload = (await response.json().catch(() => null)) as
    | (T & { error?: string })
    | null;

  if (!response.ok || !payload) {
    throw new Error(
      payload?.error || `The request failed with HTTP ${response.status}.`,
    );
  }

  return payload;
}

export function generateBillsForMonth(billingMonth?: string) {
  return postJson<BulkGenerateResult>("/api/billing/bulk-generate", {
    billingMonth,
  });
}

export type DeleteUnapprovedResult = {
  success: boolean;
  deletedCount: number;
  deletedIds: string[];
};

export function approveBills(billIds: string[]) {
  return postJson<ApprovalResult>("/api/billing/approve", { billIds });
}

export function deleteUnapprovedBills(billIds: string[]) {
  return postJson<DeleteUnapprovedResult>("/api/billing/delete-unapproved", {
    billIds,
  });
}

