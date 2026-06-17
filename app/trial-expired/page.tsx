import { getTrialStatus } from '@/lib/trial';

export default function TrialExpiredPage() {
  const status = getTrialStatus();
  const supportEmail = process.env.TRIAL_SUPPORT_EMAIL;

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 py-12 text-white">
      <section className="w-full max-w-xl rounded-lg border border-slate-800 bg-slate-900 p-8 shadow-2xl">
        <div className="text-sm font-semibold uppercase tracking-[0.18em] text-emerald-300">VQ Desk Trial</div>
        <h1 className="mt-4 text-3xl font-bold tracking-tight">Trial access has ended</h1>
        <p className="mt-4 text-slate-300">
          {status.clientName} no longer has an active trial for this VQ Desk demo.
        </p>
        {status.expiresAt && (
          <p className="mt-3 text-sm text-slate-400">
            Expired on {new Date(status.expiresAt).toLocaleDateString('en-IN', {
              day: '2-digit',
              month: 'short',
              year: 'numeric',
            })}.
          </p>
        )}
        <p className="mt-6 text-sm text-slate-400">
          Contact the VQ Desk owner to extend access, convert this trial, or export/delete trial data.
        </p>
        {supportEmail && (
          <a
            href={`mailto:${supportEmail}`}
            className="mt-6 inline-flex rounded-lg bg-emerald-400 px-4 py-2 font-semibold text-slate-950 transition hover:bg-emerald-300"
          >
            Contact support
          </a>
        )}
      </section>
    </main>
  );
}
