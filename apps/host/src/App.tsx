import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { SessionSnapshot } from "./types";

const REFRESH_INTERVAL_MS = 5_000;

function shortId(value: string): string {
  return value.length > 12 ? `${value.slice(0, 8)}…${value.slice(-4)}` : value;
}

function runtimeTone(state: SessionSnapshot["runtime"]["state"]): string {
  switch (state) {
    case "ready":
      return "bg-emerald-400/10 text-emerald-300 ring-emerald-400/20";
    case "starting":
      return "bg-amber-400/10 text-amber-200 ring-amber-400/20";
    case "interrupted":
    case "failed":
      return "bg-rose-400/10 text-rose-300 ring-rose-400/20";
    case "unloaded":
      return "bg-slate-400/10 text-slate-300 ring-slate-400/20";
  }
}

function foregroundLabel(session: SessionSnapshot): string {
  switch (session.foreground.state) {
    case "idle":
      return session.foreground.last_stop_reason
        ? `Idle · ${session.foreground.last_stop_reason}`
        : "Idle";
    case "running":
      return "Running";
    case "requires_action":
      return "Requires action";
  }
}

export default function App() {
  const [sessions, setSessions] = useState<SessionSnapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const [lastUpdated, setLastUpdated] = useState<Date>();

  async function refresh() {
    try {
      const next = await invoke<SessionSnapshot[]>("list_sessions");
      setSessions(next);
      setError(undefined);
      setLastUpdated(new Date());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), REFRESH_INTERVAL_MS);
    return () => window.clearInterval(interval);
  }, []);

  const activeTurns = sessions.filter((session) => session.foreground.state !== "idle").length;
  const readyRuntimes = sessions.filter((session) => session.runtime.state === "ready").length;

  return (
    <main className="min-h-screen bg-[#090b0f] text-slate-100">
      <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_top_left,rgba(45,212,191,0.08),transparent_35%),radial-gradient(circle_at_85%_20%,rgba(96,165,250,0.07),transparent_30%)]" />
      <div className="relative mx-auto flex min-h-screen max-w-6xl flex-col px-6 py-8 sm:px-10">
        <header className="flex flex-col gap-6 border-b border-white/8 pb-8 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-3 flex items-center gap-2 text-xs font-semibold uppercase tracking-[0.24em] text-teal-300/80">
              <span className="h-1.5 w-1.5 rounded-full bg-teal-300 shadow-[0_0_12px_rgba(94,234,212,0.8)]" />
              Host Agent
            </div>
            <h1 className="text-3xl font-semibold tracking-tight text-white sm:text-4xl">
              Pi-Tai Manager
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-slate-400">
              Local runtime health, broker sessions, and client attachment status. Closing this
              window leaves the Host Agent running in the menu bar.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={loading}
            className="inline-flex h-10 items-center justify-center rounded-lg border border-white/10 bg-white/[0.04] px-4 text-sm font-medium text-slate-200 transition hover:border-white/20 hover:bg-white/[0.07] disabled:cursor-wait disabled:opacity-50"
          >
            {loading ? "Refreshing…" : "Refresh status"}
          </button>
        </header>

        <section className="grid gap-3 py-6 sm:grid-cols-3">
          <StatusCard
            label="Broker sessions"
            value={sessions.length.toString()}
            detail="Stable Host identities"
          />
          <StatusCard
            label="Ready runtimes"
            value={readyRuntimes.toString()}
            detail="Supervised Pi workers"
          />
          <StatusCard
            label="Foreground work"
            value={activeTurns.toString()}
            detail="Running or awaiting action"
          />
        </section>

        {error ? (
          <section className="mb-6 rounded-xl border border-rose-400/20 bg-rose-400/[0.07] p-4 text-sm text-rose-200">
            <p className="font-medium">Host status is unavailable</p>
            <p className="mt-1 break-words text-rose-200/70">{error}</p>
          </section>
        ) : null}

        <section className="flex-1 rounded-2xl border border-white/8 bg-white/[0.025] shadow-2xl shadow-black/20 backdrop-blur">
          <div className="flex items-center justify-between border-b border-white/8 px-5 py-4 sm:px-6">
            <div>
              <h2 className="font-medium text-white">Sessions</h2>
              <p className="mt-1 text-xs text-slate-500">
                {lastUpdated ? `Updated ${lastUpdated.toLocaleTimeString()}` : "Waiting for Host"}
              </p>
            </div>
            <span className="rounded-full bg-white/[0.05] px-2.5 py-1 text-xs tabular-nums text-slate-400">
              {sessions.length}
            </span>
          </div>

          {sessions.length === 0 && !loading ? (
            <div className="flex min-h-72 flex-col items-center justify-center px-6 text-center">
              <div className="mb-4 grid h-12 w-12 place-items-center rounded-2xl border border-white/8 bg-white/[0.035] text-xl text-teal-200">
                π
              </div>
              <h3 className="font-medium text-slate-200">No Host-owned sessions yet</h3>
              <p className="mt-2 max-w-sm text-sm leading-6 text-slate-500">
                Create one through pi-tai-ctl or the ACP prototype. Session creation controls will
                arrive after the manager status surface is accepted.
              </p>
            </div>
          ) : (
            <div className="divide-y divide-white/6">
              {sessions.map((session) => (
                <SessionRow key={session.sessionId} session={session} />
              ))}
            </div>
          )}
        </section>

        <footer className="flex flex-col gap-1 py-5 text-xs text-slate-600 sm:flex-row sm:items-center sm:justify-between">
          <span>Local-only prototype · authenticated IPC</span>
          <span>Pi-Tai 0.1.0</span>
        </footer>
      </div>
    </main>
  );
}

function StatusCard({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div className="rounded-xl border border-white/8 bg-white/[0.025] px-5 py-4">
      <p className="text-xs font-medium uppercase tracking-wider text-slate-500">{label}</p>
      <div className="mt-2 flex items-end justify-between gap-4">
        <strong className="text-2xl font-semibold tabular-nums text-white">{value}</strong>
        <span className="pb-0.5 text-right text-xs text-slate-600">{detail}</span>
      </div>
    </div>
  );
}

function SessionRow({ session }: { session: SessionSnapshot }) {
  const cwd = session.piSession?.cwd ?? "No Pi runtime loaded";
  return (
    <article className="grid gap-4 px-5 py-5 transition hover:bg-white/[0.018] sm:grid-cols-[minmax(0,1fr)_auto] sm:px-6">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="font-mono text-sm font-medium text-slate-200" title={session.sessionId}>
            {shortId(session.sessionId)}
          </h3>
          <span
            className={`rounded-full px-2 py-0.5 text-[11px] font-medium capitalize ring-1 ring-inset ${runtimeTone(session.runtime.state)}`}
          >
            {session.runtime.state}
          </span>
          <span className="rounded-full bg-sky-400/8 px-2 py-0.5 text-[11px] font-medium text-sky-200/80 ring-1 ring-inset ring-sky-400/15">
            {foregroundLabel(session)}
          </span>
        </div>
        <p className="mt-2 truncate font-mono text-xs text-slate-500" title={cwd}>
          {cwd}
        </p>
      </div>
      <dl className="grid grid-cols-3 gap-5 text-right text-xs sm:min-w-64">
        <Metric label="Revision" value={session.revision.toString()} />
        <Metric label="Clients" value={session.attachmentCount.toString()} />
        <Metric label="Generation" value={session.runtimeGeneration.toString()} />
      </dl>
    </article>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-slate-600">{label}</dt>
      <dd className="mt-1 font-mono text-slate-300">{value}</dd>
    </div>
  );
}
