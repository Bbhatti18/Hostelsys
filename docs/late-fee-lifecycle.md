Late fee lifecycle (local migration only)
=======================================

The corrective migration `20260930120000_rent_dates_relaxation_reminders.sql`
follows the existing finance and late-fee ledger migrations. Apply separately
through your normal release process; this implementation runs locally only.

For each Rent bill, let D = bill.due_date and E = the next actual Rent bill's
due_date strictly after D for the same admission AND resident. Only bills in
Pending, Partially Paid, Overdue or Paid state establish this boundary.
S = max(D + 1 day, first day of the Karachi as-of calendar month).
N = max(0, min(Karachi as-of date, E - 1 day) - S + 1 day). If no next bill exists,
the end is the as-of date, with no invented monthly/anniversary end boundary.
On calendar dates 1–5 the payable calculation is zero. From the 6th it is N *
Rs.300, including eligible relaxation days. A bill due later never inherits
pre-due days. This is the current calendar month's basis: an already-overdue
bill on the 6th is Rs.1,800. Accrual requires
positive outstanding rent after proportional discount and rent-first verified
payments, a current admission, and a payable Rent bill. Existing charged amounts
survive rent settlement; no more accrues once rent is cleared. Before rent credit
becomes effective, the payment ledger guard atomically materializes the eligible
fine, including rent-only and ordinary combined payments. It remains a separate
unpaid obligation. Each bill owns its own obligation.

Recalculation uses the current actual boundary, so an earlier recorded Rs.6,300
charge can become Rs.3,000. Active receipt-bound freezes remain unchanged until
verification or release. The saved accrual_as_of_date preserves the amount earned
before rent settlement without adding later days. Paid obligations do not reopen
through Charge/recalculation, even if rent remains outstanding. A real payment
reversal can restore an outstanding amount.

Historical paid_amount and waived_amount are preserved even when their sum
exceeds a corrected charge. Payable remains max(charge - waiver - payment, 0);
reconciliation does not issue a refund or delete a payment/waiver. Recalculation
history records both payable and calculated before/after amounts, actor, time and
reason. Financial status is derived on every write; Charged, Released and Reversed
audit actions do not overwrite a financially settled Paid/Waived status.

Initial Rent is due on admission. Recurring Rent is due one day before the
admission anniversary, clamped to the target month's last day before subtracting.
A due date before admission is refused for charging or submission and produces
no new accrual. The corrective migration repairs only current/future recurring
bills for the current admission with no payments, receipts, allocations or fine
ledger. It leaves initial, historical and financially touched records unchanged.

Daily reminders run at 04:00 UTC (09:00 Asia/Karachi) using
`GET /api/cron/rent-reminders`. Configure `CRON_SECRET` in the deployment's server
environment; Vercel supplies its bearer token. No browser/staff bulk-send route
is provided. The endpoint uses the existing transactional email/Gmail fallback.
Only the current calendar billing month's outstanding Rent for a current
Pending/Active admission and Pending/Active resident is selected, from the 1st,
including Rent whose actual due date is later in the month. Deposit-only balances
are excluded. Quotes preserve existing receipt freezes, waivers and payments.

`rent_reminder_deliveries` records a unique resident/bill/Karachi-day claim before
delivery. Successful and uncertain claims cannot resend that day, including after
a crash between SMTP acceptance and recording success. Failed/uncertain delivery
requires operator review; there is deliberately no automatic claim expiry for
Gmail, which lacks provider idempotency. A later calendar day gets a new claim.
A run reaching its 270-second/1,000-message budget returns HTTP 503 with counts;
an authenticated scheduler retry continues with unclaimed bills. Deployment
requires a Vercel plan supporting the configured 300-second function duration.
Local reminder tests inject the transport and never load credentials or send mail.

Authenticated RPCs (normal Supabase user session; never a service-role browser key):

- `quote_late_fee({p_bill_id})`: resident-owned or active staff read; returns rent_due,
  late_fee_due, due_date, waived_amount, frozen. Does not charge or mutate history.
- `adjust_late_fee({p_bill_id,p_action:'Charge'|'Waive',p_waived_amount,p_reason})`:
  active Admin/Super Admin only, based on authenticated identity and staff status.
  Waive sets the total waiver (not an incremental subtraction), bounded by the
  calculated charge minus verified fine payments, or its existing historical
  waiver if reconciliation lowered that bound. Charge recalculates the obligation
  and preserves prior waivers and settled financial status.
  Reasons are required. Frozen obligations must be rejected/cancelled first.

Resident submission uses the existing authenticated multipart endpoint
`POST /api/resident-portal/combined-payment`. Existing fields and the original
Rent + Security Deposit behavior are unchanged. For fine payments add
`includeLateFee=true`, `rentBillId` (always the fine's rent bill), and:

- Fine only: `includeRent=false`, omit depositBillId.
- Rent + Fine: `includeRent=true`, omit depositBillId.
- Rent + Deposit + Fine: `includeRent=true`, include depositBillId.

Supply admissionId, amount, paymentMethod, referenceNumber, optional notes and file
as before. Amount must exactly match the database calculation; stale quotes fail
atomically with HTTP 409. Rent + Fine settles outstanding rent; the three-part
option retains the established exact rent-bill + deposit-bill balance validation.
Individual rent/deposit submission remains available through its existing flow.
No resident dashboard/popup or full fine UI is added in this step.

The submission RPC creates the pending payment, receipt, normal allocations, fine
allocation and freeze in one transaction. A conflicting receipt is rejected.
Verification uses the existing staff endpoint and extended allocation RPC. Only
the exact frozen fine allocation can reduce the fee. Receipt and payment totals
must equal the sum of both allocation tables. Rejection/cancellation releases the
matching freeze and recalculates only while rent remains outstanding. Verification
delay does not increase the frozen amount. Payment cancellation reverses an applied
fine exactly once and keeps the allocation and history. Resolve a newer pending
freeze before reversing an earlier fine payment.

Local tests execute the actual SQL in isolated PostgreSQL (PGlite), with the
existing finance migration chain and mocked Supabase auth functions. No .env file,
network database connection, or remote Supabase data is used. Storage migration is
outside this SQL harness; storage upload checks remain in the existing API.

Install the isolated test dependency if necessary:
`npm install --no-save --package-lock=false --ignore-scripts --prefix .local-checks/late-fee-db @electric-sql/pglite`

Run `node tools/test_late_fee.cjs`, `node tools/test_finance_integration.cjs`,
`npx tsc --noEmit --incremental false`, and `git diff --check`.
Before remote application, validate the chain against a staging copy of the actual
schema and review existing due dates, roles and data. PGlite verifies transaction
rollback and serial conflicting submissions, not multiple-connection lock scheduling.
