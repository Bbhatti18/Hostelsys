export type RentReminder = {
  id: string; residentName: string; email: string; billId: string;
  day: string; dueDate: string; rent: number; lateFee: number;
};

export function buildRentReminderEmail(reminder: RentReminder) {
  const money = (value: number) => `Rs ${Number(value).toLocaleString("en-PK", { maximumFractionDigits: 2 })}`;
  const text = [
    `Hello ${reminder.residentName},`,
    `Your Rent reminder for ${reminder.day}:`,
    `Outstanding Rent: ${money(reminder.rent)}`,
    `Actual Rent due date: ${reminder.dueDate}`,
    `Current payable Late Fee: ${money(reminder.lateFee)}`,
    `Total currently payable (Rent + Late Fee): ${money(Number(reminder.rent) + Number(reminder.lateFee))}`,
    "Please visit your Resident Portal to review your bill and submit payment.",
  ].join("\n");
  const escaped = text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
  return { to: reminder.email, subject: `Rent reminder — due ${reminder.dueDate}`,
    text, html: `<div style="white-space:pre-line">${escaped}</div>`,
    idempotencyKey: `rent-reminder/${reminder.billId}/${reminder.day}` };
}

// Dependencies are injected so local tests never import credentials or email transports.
export async function runRentReminders(deps: {
  claim: () => Promise<RentReminder | null>;
  send: (email: ReturnType<typeof buildRentReminderEmail>) => Promise<{ status: string; providerMessageId: string | null }>;
  complete: (id: string, status: string, providerMessageId: string | null) => Promise<void>;
}, limit = 1000, deadline = Date.now() + 270_000) {
  let attempted = 0, sent = 0;
  while (attempted < limit && Date.now() < deadline) {
    const reminder = await deps.claim();
    if (!reminder) break;
    attempted++;
    const result = await deps.send(buildRentReminderEmail(reminder));
    await deps.complete(reminder.id, result.status, result.providerMessageId);
    if (result.status === "sent") sent++;
  }
  return { attempted, sent, budgetReached: attempted >= limit || Date.now() >= deadline };
}
