import { supabase } from "@/lib/supabase";

export type MaintenanceNotificationClientResult = {
  success: boolean;
  emailSent: boolean;
  recipientEmail?: string;
  error?: string;
};

/**
 * Calls the server API to send the completion email notification to the resident
 * associated with this maintenance request.
 */
export async function notifyMaintenanceCompleted(
  requestId: string,
): Promise<MaintenanceNotificationClientResult> {
  try {
    let { data } = await supabase.auth.getSession();
    if (!data.session?.access_token) {
      const refreshed = await supabase.auth.refreshSession();
      data = refreshed.data;
    }
    const accessToken = data.session?.access_token;
    if (!accessToken) {
      return { success: false, emailSent: false, error: "No active session." };
    }

    const response = await fetch("/api/maintenance/notify-completed", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ requestId }),
    });

    const payload = (await response.json().catch(() => null)) as {
      success?: boolean;
      emailSent?: boolean;
      recipientEmail?: string;
      error?: string;
    } | null;

    if (!response.ok) {
      return {
        success: false,
        emailSent: false,
        error: payload?.error || "Failed to notify resident.",
      };
    }

    return {
      success: payload?.success === true,
      emailSent: payload?.emailSent === true,
      recipientEmail: payload?.recipientEmail,
    };
  } catch (err) {
    return {
      success: false,
      emailSent: false,
      error: err instanceof Error ? err.message : "Network error.",
    };
  }
}
