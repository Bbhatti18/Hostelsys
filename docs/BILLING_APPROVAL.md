# Monthly billing, approval and resident notification

## Flow

1. **Generate All Bills** (`/billing`) posts to `POST /api/billing/bulk-generate`
   with the admin's Supabase access token as a bearer. The route walks every
   admission with `status = 'Active'`, takes `monthly_rent` from the admission
   (falling back to the resident's non-cancelled contract), and inserts one bill
   per admission with:
   - `bill_status = 'Pending Approval'`
   - `due_date` is one day before the admission anniversary in the billing month (clamp the anniversary to month end first); initial admission Rent is due on admission.
   - `total_amount = balance_amount = rent`

   Admissions that already have a bill for that month, are archived, or carry no
   rent are skipped and reported back with a reason. Cap: 500 bills per call.

2. **Approve** (per row, or **Bulk Approve** for a selection) posts to
   `POST /api/billing/approve`. Each bill is flipped to `bill_status = 'Pending'`
   with an optimistic-concurrency guard on the previous status, then the resident
   is emailed a formatted copy of the bill via Resend. A failed email never rolls
   back an approval — the response reports per-bill `emailStatus`.

3. **Resident visibility.** `app/api/resident-portal/data/route.ts` filters out
   bills whose status is `Pending Approval` or `Draft`, plus any payments and
   receipts attached to them, so residents only ever see released bills.
   `deriveBillStatus()` preserves those two statuses so an unapproved bill never
   ages into Pending or Overdue.

## Environment variables

| Variable | Required for | Notes |
| --- | --- | --- |
| `RESEND_API_KEY` | bill emails | Without it, approval still succeeds and reports `configuration_required`. |
| `NOTIFICATION_EMAIL_FROM` | bill emails | Verified Resend sender address. |
| `NOTIFICATION_EMAIL_FROM_NAME` | optional | Display name on the From header. |
| `NEXT_PUBLIC_SITE_URL` | bill emails | Absolute base URL for the "log in to pay" link. `NEXT_PUBLIC_APP_URL` is accepted as a fallback. |
| `NEXT_PUBLIC_HOSTEL_NAME` | optional | Defaults to `StayHub` in the email. |

No schema change is required: `bills.bill_status` is a free-text column with no
CHECK constraint, so `Pending Approval` is stored as-is. No table was altered or
dropped.

## Authorization

Both routes call `requireStaff()` (`lib/adminApiAuth.ts`), which verifies the
bearer token against Supabase Auth, then requires exactly one matching
`staff_users` row with `status = 'active'` and a role in
`super admin / admin / manager / accountant`. Residents and anonymous callers
get 401/403. `proxy.ts` lists both paths in `selfAuthenticatedApiPaths` so they
are not cookie-redirected to `/login` before their own checks run.

## Verification script

```bash
E2E_BASE_URL=http://localhost:3000 \
E2E_STAFF_EMAIL=admin@example.com \
E2E_STAFF_PASSWORD='...' \
node tools/e2e_billing_flow.mjs
```

It creates a tagged test resident, admission, contract and bill; asserts the
temporary-password, contract-linkage, portal-visibility, generation, approval and
authorization invariants; then deletes everything it created. Without staff
credentials the HTTP phases report as skipped rather than failing. It reads
`.env.local` for Supabase keys and never prints their values.

## Known security finding

`fix_rls.sql` left `USING (true) WITH CHECK (true)` policies for the
`authenticated` role on every public table, so any signed-in resident can read
and write every table directly with the anon key — including `staff_users` and
the plaintext `residents.portal_temp_password`. Hiding unapproved bills in the
API is therefore defence-in-depth only. A reviewed replacement is proposed in
`supabase/security/rls_hardening_proposal.sql` (deliberately outside
`supabase/migrations/`, so `apply_migrations.sh` will not apply it).
