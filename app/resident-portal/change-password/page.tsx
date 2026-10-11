"use client";

import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

export default function ResidentChangePasswordPage() {
  const router = useRouter();
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    async function prepareRecoverySession() {
      const searchParams = new URLSearchParams(window.location.search);
      const tokenHash = searchParams.get("token_hash");
      const code = searchParams.get("code");
      const type = searchParams.get("type");
      if (tokenHash && type === "recovery") {
        const { error: verificationError } = await supabase.auth.verifyOtp({
          token_hash: tokenHash,
          type: "recovery",
        });
        if (verificationError) {
          if (active) setError("This password setup link is invalid or has expired. Ask the hostel administrator for a new link.");
          return;
        }
      } else if (code) {
        const { error: codeError } = await supabase.auth.exchangeCodeForSession(code);
        if (codeError) {
          if (active) setError("This password setup link is invalid or has expired. Ask the hostel administrator for a new link.");
          return;
        }
      } else {
        const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));
        const accessToken = hashParams.get("access_token");
        const refreshToken = hashParams.get("refresh_token");
        if (accessToken && refreshToken) {
          const { error: sessionError } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
          if (sessionError) {
            if (active) setError("This password setup link is invalid or has expired. Ask the hostel administrator for a new link.");
            return;
          }
          window.history.replaceState(null, "", window.location.pathname);
        }
      }

      const { data } = await supabase.auth.getUser();
      if (!data.user) {
        if (active) setError("This password setup link is invalid or has expired. Ask the hostel administrator for a new link.");
        return;
      }
      if (active) setReady(true);
    }
    void prepareRecoverySession();
    return () => { active = false; };
  }, []);

  async function savePassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError("");
    if (password.length < 10) {
      setError("Use at least 10 characters for your password.");
      return;
    }
    if (password !== confirmation) {
      setError("The passwords do not match.");
      return;
    }

    setSaving(true);
    const { data: userData } = await supabase.auth.getUser();
    const metadata = userData.user?.user_metadata ?? {};
    const { error: updateError } = await supabase.auth.updateUser({
      password,
      data: { ...metadata, must_change_password: false },
    });
    if (updateError) {
      setError(updateError.message || "Your password could not be updated.");
      setSaving(false);
      return;
    }
    router.replace("/resident-portal");
    router.refresh();
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <section className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl sm:p-8">
        <h1 className="text-2xl font-bold text-slate-900">Set your portal password</h1>
        <p className="mt-2 text-sm text-slate-600">Choose a private password for your University Girls Hostel Resident Portal account.</p>
        {error && <p role="alert" className="mt-5 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error}</p>}
        {ready && (
          <form onSubmit={savePassword} className="mt-6 space-y-4">
            <label className="block text-sm font-medium text-slate-700">
              New password
              <input type="password" autoComplete="new-password" value={password} onChange={(event) => setPassword(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2.5" required />
            </label>
            <label className="block text-sm font-medium text-slate-700">
              Confirm password
              <input type="password" autoComplete="new-password" value={confirmation} onChange={(event) => setConfirmation(event.target.value)} className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-2.5" required />
            </label>
            <button type="submit" disabled={saving} className="w-full rounded-xl bg-indigo-600 px-5 py-3 font-semibold text-white hover:bg-indigo-700 disabled:opacity-60">
              {saving ? "Saving..." : "Save password and continue"}
            </button>
          </form>
        )}
      </section>
    </main>
  );
}
