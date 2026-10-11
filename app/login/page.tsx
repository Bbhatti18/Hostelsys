"use client";

import { normalizeIdentityEmail } from "@/lib/identity";


import { useState, useEffect, type FormEvent } from "react";
import { supabase } from "@/lib/supabase";

export default function ResidentLoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errorMessage, setErrorMessage] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [lockoutTime, setLockoutTime] = useState<number | null>(null);

  const [showForgotPassword, setShowForgotPassword] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const [resetLoading, setResetLoading] = useState(false);
  const [resetMessage, setResetMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);

  useEffect(() => {
    const checkLockout = () => {
      const storedLockout = localStorage.getItem("residentLockoutTime");
      if (storedLockout) {
        const time = parseInt(storedLockout, 10);
        if (Date.now() < time) {
          setLockoutTime(time);
        } else {
          localStorage.removeItem("residentLockoutTime");
          localStorage.removeItem("residentLoginAttempts");
        }
      }
    };
    checkLockout();
    const interval = setInterval(checkLockout, 1000);
    return () => clearInterval(interval);
  }, []);

  function recordFailedAttempt() {
    const attempts = parseInt(localStorage.getItem("residentLoginAttempts") || "0", 10) + 1;
    if (attempts >= 3) {
      const lockout = Date.now() + 30000; // 30 seconds
      localStorage.setItem("residentLockoutTime", lockout.toString());
      setLockoutTime(lockout);
      setErrorMessage("Too many failed attempts. Please wait 30 seconds.");
    } else {
      localStorage.setItem("residentLoginAttempts", attempts.toString());
    }
  }

  async function handleForgotPassword(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setResetMessage(null);

    const targetEmail = resetEmail.trim();
    if (!targetEmail) {
      setResetMessage({ type: "error", text: "Please enter your registered email address." });
      return;
    }

    setResetLoading(true);
    try {
      const redirectUrl = `${window.location.origin}/auth/callback?next=/resident-portal/change-password`;
      const { error } = await supabase.auth.resetPasswordForEmail(targetEmail, {
        redirectTo: redirectUrl,
      });

      if (error) {
        setResetMessage({
          type: "error",
          text: error.message || "Failed to send reset link. Please contact hostel administration.",
        });
      } else {
        setResetMessage({
          type: "success",
          text: "Password reset link sent! Please check your email inbox (and spam/junk folder).",
        });
      }
    } catch {
      setResetMessage({
        type: "error",
        text: "An unexpected error occurred. Please contact hostel administration.",
      });
    } finally {
      setResetLoading(false);
    }
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setErrorMessage("");

    if (lockoutTime && Date.now() < lockoutTime) {
      setErrorMessage(`Too many failed attempts. Please wait ${Math.ceil((lockoutTime - Date.now()) / 1000)} seconds.`);
      return;
    }

    const normalizedEmail = email.trim();
    const submittedPassword = password;

    if (!normalizedEmail || !submittedPassword) {
      setErrorMessage("Please enter both your email and password.");
      return;
    }

    setIsLoading(true);

    try {
      const { data: authData, error: signInError } = await supabase.auth.signInWithPassword({
        email: normalizedEmail,
        password: submittedPassword,
      });

      if (signInError) {
        recordFailedAttempt();
        setErrorMessage(
          signInError.message.includes("Invalid login credentials")
            ? "The email or password you entered is incorrect."
            : signInError.message || "Unable to sign you in right now. Please try again."
        );
        setIsLoading(false);
        return;
      }

      if (!authData.session?.user) {
        recordFailedAttempt();
        setErrorMessage("We could not complete the sign-in. Please try again.");
        setIsLoading(false);
        return;
      }

      const { data: verifiedAuth, error: verificationError } = await supabase.auth.getUser();
      const user = verifiedAuth.user;
      if (verificationError || !user?.email) {
        setErrorMessage("The sign-in did not create a valid session. Please try again.");
        setIsLoading(false);
        return;
      }

      const lookupEmail = user.email?.toLowerCase() ?? normalizedEmail.toLowerCase();

      let residentRecord = null;
      const { data: resByEmail } = await supabase
        .from("residents")
        .select("id, email, status")
        .eq("email", normalizeIdentityEmail(lookupEmail))
        .maybeSingle();

      residentRecord = resByEmail;

      if (!residentRecord && user.user_metadata?.resident_id) {
        const { data: resById } = await supabase
          .from("residents")
          .select("id, email, status")
          .eq("id", user.user_metadata.resident_id)
          .maybeSingle();
        if (resById) {
          residentRecord = resById;
        }
      }

      const residentIsActive =
        residentRecord?.email &&
        String(residentRecord.status ?? "").trim().toLowerCase() !== "archived";

      if (residentRecord && residentIsActive) {
        localStorage.removeItem("residentLoginAttempts");
        localStorage.removeItem("residentLockoutTime");
        window.location.href = "/resident-portal";
        return;
      }

      await supabase.auth.signOut();
      recordFailedAttempt();
      setErrorMessage("No active resident profile is linked to this account.");
    } catch {
      setErrorMessage("Something went wrong while signing you in. Please try again.");
    } finally {
      setIsLoading(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-5 shadow-xl sm:p-8">
        <div className="flex flex-col items-center justify-center mb-6">
          <img src="/logo.jpg" alt="University Girls Hostel" className="h-24 w-24 rounded-full object-cover shadow-sm mb-4" />
          <h1 className="text-2xl font-bold text-center text-blue-700 leading-tight sm:text-3xl">
            University Girls Hostel
          </h1>
          <p className="mt-2 text-center text-gray-500 font-medium tracking-wide">
            Resident Portal
          </p>
        </div>

        {showForgotPassword ? (
          <form className="mt-8 space-y-4" onSubmit={handleForgotPassword}>
            <div>
              <h2 className="text-lg font-semibold text-slate-800">Reset Password</h2>
              <p className="text-xs text-slate-500 mt-1">
                Enter your registered email address and we&apos;ll send you a link to reset your password.
              </p>
            </div>

            <input
              type="email"
              placeholder="Registered Email"
              value={resetEmail}
              onChange={(event) => setResetEmail(event.target.value)}
              disabled={resetLoading}
              className="w-full rounded-lg border border-slate-300 p-3 text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:bg-gray-100"
              required
            />

            {resetMessage ? (
              <p
                className={`text-sm ${
                  resetMessage.type === "success" ? "text-green-600" : "text-red-600"
                }`}
              >
                {resetMessage.text}
              </p>
            ) : null}

            <button
              type="submit"
              disabled={resetLoading}
              className="w-full rounded-lg bg-blue-600 p-3 text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-400 font-medium"
            >
              {resetLoading ? "Sending Link..." : "Send Reset Link"}
            </button>

            <div className="text-center pt-2">
              <button
                type="button"
                onClick={() => {
                  setShowForgotPassword(false);
                  setResetMessage(null);
                }}
                className="text-xs text-slate-600 hover:text-blue-600 hover:underline"
              >
                &larr; Back to Login
              </button>
            </div>
          </form>
        ) : (
          <form className="mt-8 space-y-4" onSubmit={handleSubmit}>
            <input
              type="email"
              placeholder="Email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              disabled={!!lockoutTime || isLoading}
              className="w-full rounded-lg border border-slate-300 p-3 text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:bg-gray-100"
            />

            <input
              type="password"
              placeholder="Password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              disabled={!!lockoutTime || isLoading}
              className="w-full rounded-lg border border-slate-300 p-3 text-slate-900 placeholder-slate-400 focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20 disabled:bg-gray-100"
            />

            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => {
                  setShowForgotPassword(true);
                  setResetEmail(email);
                  setResetMessage(null);
                }}
                className="text-xs text-blue-600 hover:text-blue-800 hover:underline"
              >
                Forgot password?
              </button>
            </div>

            {errorMessage ? (
              <p className="text-sm text-red-600">{errorMessage}</p>
            ) : null}

            {lockoutTime ? (
              <p className="text-sm text-amber-600 font-medium">Please wait {Math.max(0, Math.ceil((lockoutTime - Date.now()) / 1000))}s before trying again.</p>
            ) : null}

            <button
              type="submit"
              disabled={!!lockoutTime || isLoading}
              className="w-full rounded-lg bg-blue-600 p-3 text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-400 font-medium"
            >
              {isLoading ? "Signing in..." : "Login"}
            </button>
          </form>
        )}
      </div>
    </main>
  );
}
