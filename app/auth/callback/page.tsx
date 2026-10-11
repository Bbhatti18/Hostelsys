"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "@/lib/supabase";

export default function AuthCallbackPage() {
  const router = useRouter();
  const [statusMessage, setStatusMessage] = useState("Verifying your session...");
  const [errorMessage, setErrorMessage] = useState("");

  useEffect(() => {
    let active = true;

    async function handleAuthCallback() {
      try {
        const searchParams = new URLSearchParams(window.location.search);
        const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ""));

        // Check for error in query or hash
        const errorDesc = searchParams.get("error_description") || hashParams.get("error_description");
        if (errorDesc) {
          if (active) {
            setErrorMessage(errorDesc);
            setStatusMessage("");
          }
          return;
        }

        const type = searchParams.get("type") || hashParams.get("type");
        const tokenHash = searchParams.get("token_hash");
        const code = searchParams.get("code");
        const accessToken = hashParams.get("access_token");
        const refreshToken = hashParams.get("refresh_token");

        // 1. Password recovery flow
        if (type === "recovery") {
          if (tokenHash) {
            const { error: otpError } = await supabase.auth.verifyOtp({
              token_hash: tokenHash,
              type: "recovery",
            });
            if (otpError) {
              if (active) {
                setErrorMessage("This password reset link is invalid or has expired. Please request a new one.");
                setStatusMessage("");
              }
              return;
            }
          } else if (accessToken && refreshToken) {
            await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
          } else if (code) {
            await supabase.auth.exchangeCodeForSession(code);
          }

          if (active) {
            router.replace("/resident-portal/change-password");
          }
          return;
        }

        // 2. PKCE code exchange
        if (code) {
          const { error: exchangeError } = await supabase.auth.exchangeCodeForSession(code);
          if (exchangeError) {
            if (active) {
              setErrorMessage("Unable to verify your login session. Please sign in again.");
              setStatusMessage("");
            }
            return;
          }
        } else if (accessToken && refreshToken) {
          await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
        }

        // 3. Verify authenticated user and route appropriately
        const { data: authData } = await supabase.auth.getUser();
        if (authData?.user) {
          router.replace("/resident-portal");
        } else {
          router.replace("/login");
        }
      } catch {
        if (active) {
          setErrorMessage("An unexpected error occurred during authentication. Please sign in manually.");
          setStatusMessage("");
        }
      }
    }

    void handleAuthCallback();

    return () => {
      active = false;
    };
  }, [router]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-100 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-xl text-center">
        <h1 className="text-xl font-bold text-slate-900 mb-2">Authentication</h1>
        {statusMessage && (
          <div className="space-y-4">
            <div className="mx-auto h-8 w-8 animate-spin rounded-full border-4 border-indigo-600 border-t-transparent" />
            <p className="text-sm text-slate-600">{statusMessage}</p>
          </div>
        )}
        {errorMessage && (
          <div className="space-y-4">
            <p className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{errorMessage}</p>
            <a
              href="/login"
              className="inline-block rounded-xl bg-indigo-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-indigo-700"
            >
              Go to Login
            </a>
          </div>
        )}
      </div>
    </main>
  );
}
