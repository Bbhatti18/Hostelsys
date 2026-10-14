import { NextRequest, NextResponse } from "next/server";
import { requireStaff, BILLING_STAFF_ROLES, apiError, apiJson } from "@/lib/adminApiAuth";
import { getAllWaiverRequests, reviewWaiverRequest } from "@/lib/fineWaivers";

export async function GET(request: NextRequest) {
  try {
    const authResult = await requireStaff(request, BILLING_STAFF_ROLES);
    if (!authResult.staff) return authResult.response;

    const requests = await getAllWaiverRequests();
    return apiJson({ requests });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to load fine waiver requests.";
    return apiError(message, 500);
  }
}

export async function POST(request: NextRequest) {
  try {
    const authResult = await requireStaff(request, BILLING_STAFF_ROLES);
    if (!authResult.staff) return authResult.response;

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== "object") {
      return apiError("Invalid request body.", 400);
    }

    const { requestId, action, waivedAmount, adminNotes } = body;
    if (!requestId || typeof requestId !== "string") {
      return apiError("Request ID is required.", 400);
    }

    if (!["FULL_WAIVER", "PARTIAL_WAIVER", "REJECT"].includes(action)) {
      return apiError("Action must be FULL_WAIVER, PARTIAL_WAIVER, or REJECT.", 400);
    }

    if (action === "PARTIAL_WAIVER") {
      const num = Number(waivedAmount);
      if (!Number.isFinite(num) || num <= 0) {
        return apiError("A positive waiver amount is required for partial waivers.", 400);
      }
    }

    const result = await reviewWaiverRequest({
      requestId,
      action,
      waivedAmount: waivedAmount ? Number(waivedAmount) : undefined,
      adminNotes: adminNotes ? String(adminNotes) : undefined,
      reviewerEmail: authResult.staff.email,
    });

    if (result.error) {
      return apiError(result.error, 400);
    }

    return apiJson({ success: true, request: result.data });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Failed to process fine waiver decision.";
    return apiError(message, 500);
  }
}
