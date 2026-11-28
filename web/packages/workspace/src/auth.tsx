// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 CasualOffice

// First-run setup (1a), sign in (2a), sign up from an invite (2b), password reset, and the
// page a public-link visitor opens.

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Archive, Check, ChevronRight, Fingerprint, KeyRound, LogIn, UserPlus } from "lucide-react";
import { addPasskey, deviceName, passkeysSupported, signInWithPasskey } from "./passkey";
import { api, ApiError } from "./api";
import { go } from "./router";
import { Brand } from "./ui";

function Field({ id, label, hint, ...p }: { id: string; label: string; hint?: string } & React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <div className="fg">
      <label className="lbl" htmlFor={id}>
        {label}
      </label>
      <div className="inp lg">
        <input id={id} {...p} />
      </div>
      {hint && <span className="hint">{hint}</span>}
    </div>
  );
}

function Err({ e }: { e: string }) {
  return e ? (
    <p className="form-err" role="alert">
      {e}
    </p>
  ) : null;
}

const msg = (e: unknown) => (e instanceof ApiError ? e.message : "Something went wrong. Try again.");

function strength(pw: string): number {
  let s = Math.min(pw.length, 20) / 20;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s += 0.1;
  if (/\d/.test(pw) || /\s/.test(pw)) s += 0.1;
  return Math.min(1, s);
}

export function Setup({ codeRequired, publicUrl, onDone }: { codeRequired: boolean; publicUrl: string | null; onDone: () => void }) {
  const steps = [...(codeRequired ? ["Setup code"] : []), "Organisation", "Your admin account", "First workspace", "Ready"];
  const [i, setI] = useState(0);
  const [f, setF] = useState({ code: "", orgName: "", publicUrl: publicUrl || location.origin, adminName: "", adminEmail: "", adminPassword: "", workspaceName: "General", sample: true });
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const step = steps[i]!;
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: k === "sample" ? e.target.checked : e.target.value });
  const next = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    if (step === "Organisation" && !f.orgName.trim()) return setErr("Name your organisation.");
    if (step === "Your admin account") {
      if (!f.adminName.trim() || !f.adminEmail.includes("@")) return setErr("Enter your name and e-mail.");
      if (f.adminPassword.length < 10) return setErr("Use at least 10 characters.");
    }
    if (step === "First workspace") {
      setBusy(true);
      try {
        await api.post("/setup", f);
        setI(i + 1);
      } catch (x) {
        setErr(msg(x));
      } finally {
        setBusy(false);
      }
      return;
    }
    if (step === "Ready") return onDone();
    setI(i + 1);
  };
  const n = steps.length - 1;
  return (
    <div className="setup">
      <div className="st-l">
        <div className="brand">
          <span className="logo">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <rect width="18" height="18" x="3" y="3" rx="3" />
              <path d="M7 8h6M7 12h10M7 16h4" />
            </svg>
          </span>
          <span className="brand-t">
            <b>OpenCanvas Workspace</b>
            <small>by CasualOffice</small>
          </span>
        </div>
        <ol>
          {steps.map((s, k) => (
            <li key={s} data-s={k < i ? "done" : k === i ? "now" : ""} aria-current={k === i ? "step" : undefined}>
              <span className="nb">{k < i ? <Check size={12} /> : k + 1}</span>
              {s}
            </li>
          ))}
        </ol>
        <div className="foot">Everything is stored in the data volume. You can change all of this later in Settings.</div>
      </div>
      <div className="st-r">
        <form className="st-p" onSubmit={next}>
          {step !== "Ready" && <div className="k">Step {i + 1} of {n}</div>}
          {step === "Setup code" && (
            <>
              <h3>Enter the setup code</h3>
              <p>To make sure you run this server, type the six words printed in the container log (docker logs). This is only asked once.</p>
              <Field id="code" label="Setup code" value={f.code} onChange={set("code")} placeholder="maple orbit lantern seven quiet harbor" autoComplete="off" />
              <p className="hint">Opened from the same machine as the server? This step is skipped.</p>
            </>
          )}
          {step === "Organisation" && (
            <>
              <h3>Name your organisation</h3>
              <p>People see this name when they sign in and in invites.</p>
              <Field id="org" label="Organisation name" value={f.orgName} onChange={set("orgName")} autoFocus />
              <Field id="url" label="Public address" value={f.publicUrl} onChange={set("publicUrl")} hint="Used for invite links and passkeys. Filled from the address you opened." />
            </>
          )}
          {step === "Your admin account" && (
            <>
              <h3>Create the admin account</h3>
              <p>You will be the Owner. You can add more admins later.</p>
              <Field id="an" label="Your name" value={f.adminName} onChange={set("adminName")} autoComplete="name" autoFocus />
              <Field id="ae" label="E-mail" type="email" value={f.adminEmail} onChange={set("adminEmail")} autoComplete="email" />
              <Field id="ap" label="Password" type="password" value={f.adminPassword} onChange={set("adminPassword")} autoComplete="new-password" />
              <div className="meter" aria-hidden="true">
                <i style={{ width: `${strength(f.adminPassword) * 100}%` }} />
              </div>
              <span className="hint">At least 10 characters, not a known leaked password.</span>
            </>
          )}
          {step === "First workspace" && (
            <>
              <h3>Create your first workspace</h3>
              <p>Workspaces group files by team or project. Everyone in the organisation can join an open workspace.</p>
              <Field id="wn" label="Workspace name" value={f.workspaceName} onChange={set("workspaceName")} autoFocus />
              <div className="sec">
                <label className="sec-r" htmlFor="sample">
                  <span className="m">
                    <b>Add a Welcome workspace</b>
                    <small>Three sample documents: welcome, meeting notes and a project plan.</small>
                  </span>
                  <input id="sample" type="checkbox" checked={f.sample} onChange={set("sample")} className="sw-check" />
                </label>
              </div>
            </>
          )}
          {step === "Ready" && (
            <>
              <div className="k" style={{ color: "var(--green-fg)" }}>
                All set
              </div>
              <h3>{f.orgName} is ready</h3>
              <p>Your workspace is running. A few things worth doing next:</p>
              <div className="sec">
                {[
                  [<UserPlus size={16} key="u" />, "t-blue", "Invite people", "Copy an invite link, no e-mail needed"],
                  [<KeyRound size={16} key="k" />, "t-purple", "Choose sign-in rules", "Who may sign up, and public links"],
                  [<Archive size={16} key="a" />, "t-green", "Back up the data volume", "Including its secrets folder"],
                ].map((r) => (
                  <div className="sec-r okrow" style={{ padding: ".625rem 1rem" }} key={r[2] as string}>
                    <span className={`ic ${r[1]}`}>{r[0]}</span>
                    <span className="m">
                      <b>{r[2]}</b>
                      <small>{r[3]}</small>
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
          <Err e={err} />
          <div className="st-a">
            {i > 0 && step !== "Ready" && (
              <button type="button" className="btn sec lg" onClick={() => setI(i - 1)}>
                Back
              </button>
            )}
            <span className="sp" />
            <button className="btn pri lg" disabled={busy}>
              {step === "First workspace" ? "Finish setup" : step === "Ready" ? `Open ${f.orgName}` : "Continue"}
              <ChevronRight size={16} />
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

export function SignIn({ onDone }: { onDone: () => void }) {
  const [brand, setBrand] = useState<{ orgName: string; accent: string; signInMessage: string } | null>(null);
  useEffect(() => {
    api.get<NonNullable<typeof brand>>("/branding").then((b) => {
      setBrand(b);
      document.documentElement.style.setProperty("--accent", b.accent);
    }, () => {});
  }, []);
  const [email, setEmail] = useState("");
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [forgot, setForgot] = useState(false);
  const conditional = useRef<AbortController | null>(null);
  const done = useRef(onDone);
  done.current = onDone;
  // Conditional UI: the browser offers saved passkeys in the e-mail field's autofill.
  useEffect(() => {
    if (!passkeysSupported()) return;
    const ac = new AbortController();
    conditional.current = ac;
    (PublicKeyCredential as unknown as { isConditionalMediationAvailable?: () => Promise<boolean> }).isConditionalMediationAvailable?.().then((ok) => {
      if (ok) signInWithPasskey(true, ac.signal).then(() => done.current(), () => {});
    });
    return () => ac.abort();
  }, []);
  const passkey = async () => {
    setErr("");
    try {
      // One WebAuthn request at a time: the pending autofill request steps aside.
      conditional.current?.abort();
      await new Promise((r) => setTimeout(r, 0));
      await signInWithPasskey();
      onDone();
    } catch (x) {
      if ((x as Error).name !== "NotAllowedError" && (x as Error).name !== "AbortError") setErr(msg(x));
    }
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    try {
      await api.post("/auth/login", { email, password: pw });
      onDone();
    } catch (x) {
      setErr(msg(x));
    }
  };
  return (
    <div className="auth">
      <form className="auth-c" onSubmit={submit}>
        <Brand org={brand?.orgName} />
        <h3>Sign in{brand ? ` to ${brand.orgName}` : ""}</h3>
        <p>{brand?.signInMessage || "Welcome back. Use the passkey on this device, or your e-mail and password."}</p>
        {passkeysSupported() && (
          <>
            <button type="button" className="btn pri lg full" onClick={passkey}>
              <Fingerprint size={16} />
              Sign in with a passkey
            </button>
            <div className="or">or with e-mail</div>
          </>
        )}
        <Field id="si-e" label="E-mail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username webauthn" autoFocus />
        <div className="fg">
          <label className="lbl" htmlFor="si-p" style={{ display: "flex" }}>
            Password
            <button type="button" className="lnk lnk-btn" style={{ marginLeft: "auto" }} onClick={() => setForgot(true)}>
              Forgot password?
            </button>
          </label>
          <div className="inp lg">
            <input id="si-p" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="current-password" />
          </div>
        </div>
        {forgot && (
          <p className="hint" role="status">
            Ask an admin for a reset link (Members, then Reset sign-in). The operator can also run <code>opencanvas-workspace admin reset-password</code>.
          </p>
        )}
        <Err e={err} />
        <button className={`btn ${passkeysSupported() ? "sec" : "pri"} lg full`}>
          <LogIn size={16} />
          Sign in
        </button>
        <div className="auth-ft">Need an account? Ask an admin for an invite.</div>
      </form>
    </div>
  );
}

export function InviteSignup({ token, onDone }: { token: string; onDone: (next: string) => void }) {
  const [info, setInfo] = useState<{ org: string; invitedBy?: string; kind: string; targetName?: string; role: string; email?: string; expiresAt: number } | null>(null);
  const [err, setErr] = useState("");
  const [f, setF] = useState({ name: "", email: "", password: "" });
  useEffect(() => {
    api.get<typeof info>(`/invites/${token}`).then(setInfo, (e) => setErr(msg(e)));
  }, [token]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    try {
      const r = await api.post<{ next: string }>("/auth/signup", { invite: token, ...f, email: info?.email || f.email });
      onDone(r.next);
    } catch (x) {
      setErr(msg(x));
    }
  };
  const withPasskey = async () => {
    setErr("");
    if (!f.name.trim()) return setErr("Enter your name.");
    try {
      const r = await api.post<{ next: string }>("/auth/signup", { invite: token, name: f.name, email: info?.email || f.email, passkey: true });
      try {
        await addPasskey(deviceName());
      } catch {
        // The account exists; without a passkey it needs a password (You page) or an admin reset.
        setErr("The account was made, but the passkey wasn't. Add one, or a password, on your page.");
      }
      onDone(r.next);
    } catch (x) {
      setErr(msg(x));
    }
  };
  const what = info && (info.kind === "org" ? `${info.org} as a ${info.role}` : info.kind === "workspace" ? `the ${info.targetName} workspace as ${info.role === "admin" ? "an Admin" : `a ${info.role}`}` : `“${info.targetName}”`);
  return (
    <div className="auth">
      <form className="auth-c" onSubmit={submit}>
        <Brand org={info?.org} />
        <h3>Join {info?.org ?? "the workspace"}</h3>
        {info && (
          <div className="inv">
            <span>
              <b>{info.invitedBy ?? "An admin"}</b> invited you to {what}. The invite expires on {new Date(info.expiresAt).toLocaleDateString([], { day: "numeric", month: "long" })}.
            </span>
          </div>
        )}
        {info && (
          <>
            <Field id="su-n" label="Your name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoComplete="name" autoFocus />
            <Field id="su-e" label="E-mail" type="email" value={info.email || f.email} readOnly={!!info.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="email" />
            {passkeysSupported() && (
              <>
                <button type="button" className="btn pri lg full" onClick={withPasskey}>
                  <Fingerprint size={16} />
                  Create account with a passkey
                </button>
                <div className="or">or</div>
              </>
            )}
            <Field id="su-p" label="Choose a password" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" />
            <div className="meter" aria-hidden="true">
              <i style={{ width: `${strength(f.password) * 100}%` }} />
            </div>
            <span className="hint">At least 10 characters, not a known leaked password.</span>
          </>
        )}
        <Err e={err} />
        {info && <button className={`btn ${passkeysSupported() ? "sec" : "pri"} lg full`}>Create account</button>}
        <div className="auth-ft">
          Already have an account?{" "}
          <a href="/ws/signin" className="lnk">
            Sign in
          </a>
        </div>
      </form>
    </div>
  );
}

export function Reset({ token }: { token: string }) {
  const [email, setEmail] = useState<string | null>(null);
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const [done, setDone] = useState(false);
  useEffect(() => {
    api.get<{ email: string }>(`/reset/${token}`).then((r) => setEmail(r.email), (e) => setErr(msg(e)));
  }, [token]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await api.post("/auth/reset", { token, password: pw });
      setDone(true);
    } catch (x) {
      setErr(msg(x));
    }
  };
  return (
    <div className="auth">
      <form className="auth-c" onSubmit={submit}>
        <Brand />
        <h3>{done ? "Password changed" : "Choose a new password"}</h3>
        {done ? (
          <>
            <p>You were signed out everywhere. Sign in with the new password.</p>
            <button type="button" className="btn pri lg full" onClick={() => go("/signin")}>
              Sign in
            </button>
          </>
        ) : (
          <>
            {email && <p>For {email}.</p>}
            {email && <Field id="np" label="New password" type="password" value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" autoFocus />}
            <Err e={err} />
            {email && <button className="btn pri lg full">Change password</button>}
          </>
        )}
      </form>
    </div>
  );
}

/** A public link (owner decision 6): name, password when set, then the editor. */
export function LinkVisit({ token, onOpen }: { token: string; onOpen: (launch: { token: string; type: string; name: string; role: string }) => void }) {
  const [info, setInfo] = useState<{ name: string; type: string; role: string; needsPassword: boolean; org: string } | null>(null);
  const [err, setErr] = useState("");
  const [pw, setPw] = useState("");
  const [name, setName] = useState("");
  useEffect(() => {
    api.get<typeof info>(`/links/${token}`).then(setInfo, (e) => setErr(msg(e)));
  }, [token]);
  const open = async (e: FormEvent) => {
    e.preventDefault();
    setErr("");
    try {
      onOpen(await api.post(`/links/${token}/open`, { password: pw || undefined, name: name || undefined }));
    } catch (x) {
      setErr(msg(x));
    }
  };
  return (
    <div className="auth">
      <form className="auth-c" onSubmit={open}>
        <Brand org={info?.org} />
        <h3>{info ? info.name : "Shared link"}</h3>
        {info && <p>Anyone with this link can {info.role === "view" ? "view" : info.role === "comment" ? "view and comment on" : "edit"} it, without an account.</p>}
        {info && <Field id="vn" label="Your name (shown to others here)" value={name} onChange={(e) => setName(e.target.value)} placeholder="Visitor" autoFocus />}
        {info?.needsPassword && <Field id="vp" label="Password" type="password" value={pw} onChange={(e) => setPw(e.target.value)} />}
        <Err e={err} />
        {info && <button className="btn pri lg full">Open</button>}
      </form>
    </div>
  );
}
