'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';
import { Database, LayoutDashboard, Loader2, RefreshCw, RotateCcw, Trash2 } from 'lucide-react';
import type { KnowledgeSourceSummary } from '@/lib/types';

async function readApiResponse(response: Response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { error: text || `Request failed with status ${response.status}` };
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function formatSourceType(value: string) {
  const labels: Record<string, string> = {
    policy: 'Policy / Manual',
    procedure: 'SOP / Procedure',
    previous_questionnaire: 'Previous Questionnaire',
    standard_answer: 'Standard Answers',
    other: 'Other',
  };
  return labels[value] || value.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase());
}

export default function KnowledgePage() {
  const [sources, setSources] = useState<KnowledgeSourceSummary[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reingestProgress, setReingestProgress] = useState<Record<string, string>>({});

  async function loadSources() {
    setBusy('load');
    setError(null);
    try {
      const response = await fetch('/api/knowledge/sources', { method: 'GET' });
      const data = await readApiResponse(response);
      if (!response.ok) return setError(data.error || 'Could not load knowledge library.');
      setSources(data.sources || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load knowledge library.');
    } finally {
      setBusy(null);
    }
  }

  useEffect(() => {
    loadSources();
  }, []);

  async function runReingestBatch(source: KnowledgeSourceSummary, offset: number) {
    const response = await fetch('/api/knowledge/reingest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sourceName: source.sourceName, sourceType: source.sourceType, offset, limit: 1 }),
    });
    const data = await readApiResponse(response);
    if (!response.ok) throw new Error(data.error || 'Could not refresh this source.');
    return data;
  }

  async function reingestSource(source: KnowledgeSourceSummary) {
    const ok = window.confirm(`Refresh embeddings for "${source.sourceName}"?`);
    if (!ok) return;

    const busyKey = `reingest-${source.sourceName}-${source.sourceType}`;
    const progressKey = `${source.sourceName}-${source.sourceType}`;
    let offset = 0;
    let totalChunks = source.chunks;
    let complete = false;

    setBusy(busyKey);
    setError(null);
    setMessage(null);
    setReingestProgress((current) => ({ ...current, [progressKey]: `0/${source.chunks}` }));

    try {
      while (!complete) {
        let data: any = null;
        let lastError: unknown = null;

        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            data = await runReingestBatch(source, offset);
            lastError = null;
            break;
          } catch (err) {
            lastError = err;
            await sleep(attempt * 1500);
          }
        }

        if (lastError) throw lastError;

        offset = Number(data.nextOffset || offset);
        totalChunks = Number(data.totalChunks || totalChunks);
        complete = Boolean(data.complete);
        setReingestProgress((current) => ({ ...current, [progressKey]: `${Math.min(offset, totalChunks)}/${totalChunks}` }));
        await sleep(400);
      }

      setMessage(`Refreshed ${totalChunks} sections for ${source.sourceName}.`);
      await loadSources();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not refresh this source.');
    } finally {
      setBusy(null);
      setReingestProgress((current) => {
        const next = { ...current };
        delete next[progressKey];
        return next;
      });
    }
  }

  async function deleteSource(source: KnowledgeSourceSummary) {
    const ok = window.confirm(`Remove "${source.sourceName}" from the knowledge library?`);
    if (!ok) return;
    setBusy(`delete-${source.sourceName}-${source.sourceType}`);
    setError(null);
    setMessage(null);

    try {
      const response = await fetch('/api/knowledge/sources', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceName: source.sourceName, sourceType: source.sourceType }),
      });
      const data = await readApiResponse(response);
      if (!response.ok) return setError(data.error || 'Could not remove this source.');
      setMessage(`Removed ${source.sourceName}.`);
      await loadSources();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not remove this source.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <main className="min-h-screen bg-[#eef2f6] text-slate-950">
      <div className="flex min-h-screen flex-col lg:flex-row">
        <aside className="border-b border-slate-800 bg-slate-950 px-4 py-4 text-white lg:w-72 lg:border-b-0 lg:border-r lg:px-5 lg:py-6">
          <div className="flex items-center justify-between gap-3 lg:block">
            <div>
              <div className="flex items-center gap-2 text-lg font-bold tracking-tight">
                <span className="grid h-8 w-8 place-items-center rounded-lg bg-emerald-400 text-sm font-black text-slate-950">VQ</span>
                VQ Desk
              </div>
              <p className="mt-1 text-xs font-medium uppercase tracking-[0.18em] text-slate-400">Compliance workbench</p>
            </div>
          </div>
          <nav className="mt-5 grid gap-2 text-sm font-semibold lg:mt-8">
            <Link href="/" className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-slate-300 hover:bg-slate-900 hover:text-white">
              <LayoutDashboard className="h-4 w-4" /> Questionnaire
            </Link>
            <Link href="/knowledge" className="flex items-center gap-3 rounded-lg bg-white px-3 py-2.5 text-slate-950">
              <Database className="h-4 w-4" /> Knowledge Library
            </Link>
          </nav>
        </aside>

        <div className="flex-1 px-4 py-5 md:px-8 lg:px-10">
          <div className="mx-auto max-w-7xl space-y-5">
            <header className="flex flex-col gap-4 border-b border-slate-200 pb-5 md:flex-row md:items-end md:justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.18em] text-slate-500">Controlled knowledge</p>
                <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-950 md:text-3xl">Manage approved QA sources</h1>
                <p className="mt-2 max-w-2xl text-sm text-slate-600">Review the controlled documents and answer banks used to support questionnaire drafts.</p>
              </div>
              <button onClick={loadSources} disabled={busy !== null} className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-50">
                {busy === 'load' ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />} Refresh
              </button>
            </header>

            <section className="grid gap-3 md:grid-cols-3">
              <div className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Sources</div>
                <div className="mt-2 text-2xl font-bold">{sources.length}</div>
                <div className="mt-1 text-xs text-slate-500">available for drafting</div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Sections</div>
                <div className="mt-2 text-2xl font-bold text-emerald-700">{sources.reduce((sum, source) => sum + source.chunks, 0)}</div>
                <div className="mt-1 text-xs text-slate-500">indexed source sections</div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Status</div>
                <div className="mt-2 text-2xl font-bold text-slate-700">{busy === 'load' ? 'Syncing' : busy?.startsWith('reingest-') ? 'Refreshing' : 'Ready'}</div>
                <div className="mt-1 text-xs text-slate-500">library availability</div>
              </div>
            </section>

            {(message || error) && (
              <div className="space-y-3">
                {message && <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-green-800">{message}</div>}
                {error && <div className="whitespace-pre-wrap rounded-lg border border-red-200 bg-red-50 p-4 text-red-800">{error}</div>}
              </div>
            )}

            <section className="rounded-lg border border-slate-200 bg-white p-5">
              {sources.length === 0 ? (
                <div className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-8 text-center text-slate-500">No knowledge sources saved.</div>
              ) : (
                <div className="overflow-hidden rounded-lg border border-slate-200">
                  <div className="grid grid-cols-12 gap-3 bg-slate-50 px-4 py-3 text-xs font-bold uppercase tracking-wide text-slate-500">
                    <div className="col-span-5">Source</div>
                    <div className="col-span-3">Category</div>
                    <div className="col-span-2">Sections</div>
                    <div className="col-span-2 text-right">Actions</div>
                  </div>
                  {sources.map((source) => {
                    const progressKey = `${source.sourceName}-${source.sourceType}`;
                    const deleteBusy = busy === `delete-${source.sourceName}-${source.sourceType}`;
                    const reingestBusy = busy === `reingest-${source.sourceName}-${source.sourceType}`;
                    return (
                      <div key={`${source.sourceName}-${source.sourceType}`} className="grid grid-cols-12 items-center gap-3 border-t border-slate-200 px-4 py-4 text-sm">
                        <div className="col-span-12 font-semibold text-slate-900 md:col-span-5">
                          {source.sourceName}
                          {reingestProgress[progressKey] && <div className="mt-1 text-xs font-medium text-slate-500">Refreshing {reingestProgress[progressKey]}</div>}
                        </div>
                        <div className="col-span-6 text-slate-600 md:col-span-3">{formatSourceType(source.sourceType)}</div>
                        <div className="col-span-3 text-slate-600 md:col-span-2">{source.chunks}</div>
                        <div className="col-span-3 flex justify-end gap-2 md:col-span-2">
                          <button onClick={() => reingestSource(source)} disabled={busy !== null} className="inline-flex cursor-pointer rounded-lg p-2 text-slate-600 hover:bg-slate-100 disabled:cursor-not-allowed disabled:opacity-50" aria-label={`Refresh embeddings for ${source.sourceName}`} title="Refresh embeddings">
                            {reingestBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RotateCcw className="h-4 w-4" />}
                          </button>
                          <button onClick={() => deleteSource(source)} disabled={busy !== null} className="inline-flex cursor-pointer rounded-lg p-2 text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-50" aria-label={`Remove ${source.sourceName}`} title="Remove source">
                            {deleteBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </section>
          </div>
        </div>
      </div>
    </main>
  );
}
