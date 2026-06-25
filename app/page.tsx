'use client';

import Link from 'next/link';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Clipboard,
  Database,
  FileText,
  LayoutDashboard,
  Loader2,
  Monitor,
  Pause,
  Play,
  Save,
  ShieldCheck,
  UploadCloud,
  XCircle,
} from 'lucide-react';
import type { GeneratedAnswer, KnowledgeSourceSummary, QuestionCandidate } from '@/lib/types';

const REQUEST_DELAY_MS = 8000;
const RATE_LIMIT_DELAY_MS = 90000;
const ETA_SECONDS_PER_QUESTION = 10;

type KnowledgeStreamEvent =
  | { type: 'progress'; phase: string; progress: number; fileName?: string; insertedChunks?: number; totalChunks?: number }
  | { type: 'complete'; progress: number; totalChunks: number; sources: { fileName: string; chunks: number; warnings?: string[] }[]; skipped: { fileName: string; reason: string }[] }
  | { type: 'error'; error: string; skipped?: { fileName: string; reason: string }[] };

type ExtractResponse = { totalQuestions: number; questions: QuestionCandidate[] };
type AnswerResponse = { answer: GeneratedAnswer };
type ApprovalState = 'approved' | 'needs_work';

async function readApiResponse(response: Response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { error: text || `Request failed with status ${response.status}` };
  }
}

function isRateLimitedAnswer(answer: GeneratedAnswer) {
  return /rate limit|429|too many requests|quota/i.test(answer.reason || '');
}

function humanizeKnowledgePhase(phase: string) {
  if (/complete|built|ingested/i.test(phase)) return 'Knowledge ready';
  if (/starting|reading/i.test(phase)) return 'Reading files';
  if (/embedding|chunk|vector|ingestion/i.test(phase)) return 'Saving files';
  return phase.replace(/chunks?/gi, 'sections');
}

function humanizeWorkPhase(phase: string) {
  if (/extract/i.test(phase)) return 'Reading questionnaire';
  if (/waiting/i.test(phase)) return 'Preparing next answer';
  if (/resuming/i.test(phase)) return 'Continuing';
  return phase;
}

function humanizeReviewReason(reason?: string) {
  if (!reason) return 'Please review this answer.';
  if (/rate limit|429|too many requests|quota/i.test(reason)) return 'Service was busy. Retry later or answer manually.';
  if (/confidence|similarity|retrieval|source|evidence|not found|insufficient/i.test(reason)) return 'No strong match was found.';
  if (/timeout|failed|error/i.test(reason)) return 'Could not prepare this safely.';
  if (/blank|empty|no answer/i.test(reason)) return 'No answer entered.';
  return 'Please review this answer.';
}

function formatDateTime(value: string) {
  if (!value) return 'Not added yet';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function getLatestIngestedAt(sources: KnowledgeSourceSummary[]) {
  const latest = sources
    .map((source) => new Date(source.latestIngestedAt).getTime())
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => b - a)[0];

  return latest ? formatDateTime(new Date(latest).toISOString()) : 'Not added yet';
}

function formatEta(seconds: number) {
  if (seconds <= 0) return 'Almost done';
  if (seconds < 60) return `About ${seconds}s left`;
  return `About ${Math.ceil(seconds / 60)} min left`;
}

function answerStatus(answer: GeneratedAnswer) {
  if (answer.answer.trim()) return 'Ready';
  if (answer.status === 'blank') return 'Blank';
  return 'Needs review';
}

function statusClass(answer: GeneratedAnswer) {
  if (answer.answer.trim()) return 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200';
  if (answer.status === 'blank') return 'bg-slate-100 text-slate-700 ring-1 ring-slate-200';
  return 'bg-amber-50 text-amber-700 ring-1 ring-amber-200';
}

function StatusPill({ ready, children }: { ready: boolean; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${ready ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200' : 'bg-slate-100 text-slate-600 ring-1 ring-slate-200'}`}>
      {ready ? <CheckCircle2 className="h-3.5 w-3.5" /> : <span className="h-2 w-2 rounded-full bg-slate-400" />}
      {children}
    </span>
  );
}

export default function HomePage() {
  const cancelDraftRef = useRef(false);
  const pauseDraftRef = useRef(false);
  const [knowledgeFiles, setKnowledgeFiles] = useState<FileList | null>(null);
  const [sourceType, setSourceType] = useState('policy');
  const [questionnaire, setQuestionnaire] = useState<File | null>(null);
  const [sources, setSources] = useState<KnowledgeSourceSummary[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [knowledgeProgress, setKnowledgeProgress] = useState(0);
  const [knowledgePhase, setKnowledgePhase] = useState('Reading files');
  const [fillProgress, setFillProgress] = useState(0);
  const [fillPhase, setFillPhase] = useState('Ready');
  const [message, setMessage] = useState<string | null>(null);
  const [warning, setWarning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<GeneratedAnswer[]>([]);
  const [totalQuestions, setTotalQuestions] = useState(0);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [approval, setApproval] = useState<Record<string, ApprovalState>>({});
  const [approvalBusy, setApprovalBusy] = useState<string | null>(null);
  const [expandedEvidence, setExpandedEvidence] = useState<Record<string, boolean>>({});

  const answeredCount = useMemo(() => answers.filter((answer) => answer.answer.trim()).length, [answers]);
  const reviewCount = useMemo(() => answers.filter((answer) => !answer.answer.trim() && answer.status !== 'blank').length, [answers]);
  const blankCount = useMemo(() => answers.filter((answer) => !answer.answer.trim() && answer.status === 'blank').length, [answers]);
  const pendingCount = Math.max((totalQuestions || 0) - answers.length, 0);
  const knowledgeReady = sources.length > 0;
  const questionnaireReady = Boolean(questionnaire);
  const canStart = knowledgeReady && questionnaireReady && busy === null;
  const canContinue = Boolean(questionnaire && totalQuestions > 0 && answers.length > 0 && answers.length < totalQuestions && busy === null);
  const processedLabel = totalQuestions ? `${answers.length}/${totalQuestions}` : answers.length ? `${answers.length}` : '0';
  const etaLabel = busy === 'fill' && totalQuestions ? formatEta(pendingCount * ETA_SECONDS_PER_QUESTION) : null;

  function resetDraftState() {
    cancelDraftRef.current = false;
    pauseDraftRef.current = false;
    setPaused(false);
    setAnswers([]);
    setTotalQuestions(0);
    setFillProgress(0);
    setFillPhase('Ready');
    setApproval({});
    setCopiedId(null);
    setExpandedEvidence({});
  }

  function handleQuestionnaireChange(file: File | null) {
    setQuestionnaire(file);
    resetDraftState();
    setMessage(null);
    setWarning(null);
    setError(null);
  }

  function pauseDrafting() {
    pauseDraftRef.current = true;
    setPaused(true);
    setFillPhase('Paused');
  }

  function resumeDrafting() {
    pauseDraftRef.current = false;
    setPaused(false);
    setFillPhase('Continuing');
  }

  function cancelDrafting() {
    cancelDraftRef.current = true;
    pauseDraftRef.current = false;
    setPaused(false);
    setFillPhase('Stopping');
  }

  async function waitForRunControl(ms = 0) {
    const startedAt = Date.now();
    while (Date.now() - startedAt < ms || pauseDraftRef.current) {
      if (cancelDraftRef.current) throw new Error('Drafting cancelled.');
      if (pauseDraftRef.current) {
        await new Promise((resolve) => window.setTimeout(resolve, 250));
        continue;
      }
      await new Promise((resolve) => window.setTimeout(resolve, 250));
    }
    if (cancelDraftRef.current) throw new Error('Drafting cancelled.');
  }

  async function loadSources() {
    setError(null);
    try {
      const response = await fetch('/api/knowledge/sources', { method: 'GET' });
      const data = await readApiResponse(response);
      if (!response.ok) return setError(data.error || 'Could not load knowledge library.');
      setSources(data.sources || []);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not load knowledge library.');
    }
  }

  useEffect(() => {
    loadSources();
  }, []);

  async function ingestKnowledge() {
    if (!knowledgeFiles?.length) return setError('Select at least one file.');
    setBusy('knowledge');
    setKnowledgeProgress(1);
    setKnowledgePhase('Reading files');
    setError(null);
    setWarning(null);
    setMessage(null);

    try {
      const form = new FormData();
      Array.from(knowledgeFiles).forEach((file) => form.append('files', file));
      form.append('sourceType', sourceType);

      const response = await fetch('/api/knowledge', { method: 'POST', body: form });
      if (!response.ok || !response.body) {
        const data = await readApiResponse(response);
        return setError(data.error || 'Could not save files.');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let completed = false;

      const handleEvent = (event: KnowledgeStreamEvent) => {
        if (event.type === 'progress') {
          setKnowledgeProgress(Math.max(1, Math.min(99, event.progress)));
          setKnowledgePhase(humanizeKnowledgePhase(event.phase));
          return;
        }
        if (event.type === 'complete') {
          completed = true;
          setKnowledgeProgress(100);
          setKnowledgePhase('Saved');
          const warningLines = event.sources.flatMap((source) => (source.warnings || []).map((item) => `${source.fileName}: ${item}`));
          setMessage(`${event.sources.length} file(s) saved.${event.skipped.length ? ` ${event.skipped.length} file(s) skipped.` : ''}`);
          if (event.skipped.length || warningLines.length) {
            setWarning([...warningLines, ...event.skipped.map((item) => `${item.fileName}: ${item.reason}`)].join('\n'));
          }
          return;
        }
        if (event.type === 'error') {
          const skipped = event.skipped?.map((item) => `${item.fileName}: ${item.reason}`).join('\n');
          setError(skipped ? `${event.error}\n${skipped}` : event.error);
        }
      };

      while (true) {
        const { value, done } = await reader.read();
        buffer += decoder.decode(value || new Uint8Array(), { stream: !done });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) if (line.trim()) handleEvent(JSON.parse(line) as KnowledgeStreamEvent);
        if (done) break;
      }
      if (buffer.trim()) handleEvent(JSON.parse(buffer) as KnowledgeStreamEvent);
      if (completed) await loadSources();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save files.');
    } finally {
      setBusy(null);
      setKnowledgePhase('Reading files');
    }
  }

  async function extractQuestions(file: File) {
    const form = new FormData();
    form.append('file', file);
    form.append('action', 'extract');
    const response = await fetch('/api/fill', { method: 'POST', body: form });
    const data = await readApiResponse(response);
    if (!response.ok) throw new Error(data.error || 'Could not read questionnaire.');
    return data as ExtractResponse;
  }

  async function answerOneQuestion(question: QuestionCandidate) {
    const form = new FormData();
    form.append('action', 'answer');
    form.append('questionId', question.id);
    form.append('question', question.question);
    const response = await fetch('/api/fill', { method: 'POST', body: form });
    const data = await readApiResponse(response);
    if (!response.ok) throw new Error(data.error || 'Could not draft answer.');
    return (data as AnswerResponse).answer;
  }

  async function extractAndAnswer(continueMode = false) {
    if (!questionnaire) return setError('Select a DOCX questionnaire.');
    if (!knowledgeReady) return setError('Add knowledge before drafting answers.');
    const existingAnswers = continueMode ? answers : [];

    if (!continueMode) resetDraftState();
    cancelDraftRef.current = false;
    pauseDraftRef.current = false;
    setPaused(false);
    setBusy('fill');
    setFillProgress(existingAnswers.length ? fillProgress : 1);
    setFillPhase(continueMode ? 'Continuing' : 'Reading questionnaire');
    setError(null);
    setWarning(null);
    setMessage(null);

    try {
      const extracted = await extractQuestions(questionnaire);
      const questions = extracted.questions;
      const startIndex = Math.min(existingAnswers.length, questions.length);
      setTotalQuestions(extracted.totalQuestions);

      const allAnswers: GeneratedAnswer[] = [...existingAnswers];
      for (let index = startIndex; index < questions.length; index++) {
        await waitForRunControl();
        const question = questions[index];
        setFillPhase(`Drafting ${index + 1} of ${questions.length}`);
        const answer = await answerOneQuestion(question);
        allAnswers.push(answer);
        setAnswers([...allAnswers]);
        setFillProgress(Math.min(100, Math.round((allAnswers.length / questions.length) * 100)));
        if (index < questions.length - 1) {
          const waitMs = isRateLimitedAnswer(answer) ? RATE_LIMIT_DELAY_MS : REQUEST_DELAY_MS;
          setFillPhase(`Preparing next answer (${allAnswers.length}/${questions.length})`);
          await waitForRunControl(waitMs);
        }
      }

      const answered = allAnswers.filter((item) => item.answer.trim()).length;
      setMessage(`Done. ${answered} ready, ${allAnswers.length - answered} to review.`);
    } catch (err) {
      if (cancelDraftRef.current) {
        setMessage('Drafting stopped.');
      } else {
        setError(err instanceof Error ? err.message : 'Drafting stopped. You can continue from the last answer.');
      }
    } finally {
      cancelDraftRef.current = false;
      pauseDraftRef.current = false;
      setPaused(false);
      setBusy(null);
      setFillPhase('Ready');
    }
  }

  function updateAnswer(questionId: string, value: string) {
    setAnswers((current) => current.map((answer) => {
      if (answer.questionId !== questionId) return answer;
      const hasAnswer = value.trim().length > 0;
      return {
        ...answer,
        answer: value,
        status: hasAnswer ? 'answered' : 'blank',
        confidence: hasAnswer ? Math.max(answer.confidence, 0.81) : answer.confidence,
        reason: hasAnswer ? 'Edited in review.' : 'No answer entered.',
      };
    }));
    setApproval((current) => {
      if (!current[questionId]) return current;
      const next = { ...current };
      delete next[questionId];
      return next;
    });
  }

  function markBlank(questionId: string) {
    updateAnswer(questionId, '');
  }

  async function copyAnswer(answer: GeneratedAnswer) {
    if (!answer.answer.trim()) return;
    await navigator.clipboard.writeText(answer.answer);
    setCopiedId(answer.questionId);
    window.setTimeout(() => setCopiedId(null), 1200);
  }

  async function approveToLibrary(answer: GeneratedAnswer) {
    if (!answer.answer.trim() || approvalBusy) return;
    setApprovalBusy(answer.questionId);
    setError(null);
    setWarning(null);

    try {
      const response = await fetch('/api/answers/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questionId: answer.questionId,
          question: answer.question,
          answer: answer.answer,
          vote: 'up',
        }),
      });
      const data = await readApiResponse(response);
      if (!response.ok) return setError(data.error || 'Could not save approval.');
      setApproval((current) => ({ ...current, [answer.questionId]: 'approved' }));
      await loadSources();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save approval.');
    } finally {
      setApprovalBusy(null);
    }
  }

  async function markNeedsWork(answer: GeneratedAnswer) {
    if (!answer.answer.trim() || approvalBusy) return;
    setApprovalBusy(answer.questionId);
    setError(null);
    setWarning(null);

    try {
      const response = await fetch('/api/answers/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questionId: answer.questionId,
          question: answer.question,
          answer: answer.answer,
          vote: 'down',
          reason: answer.reason || 'Marked for review',
        }),
      });
      const data = await readApiResponse(response);
      if (!response.ok) return setError(data.error || 'Could not save feedback.');
      setApproval((current) => ({ ...current, [answer.questionId]: 'needs_work' }));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save feedback.');
    } finally {
      setApprovalBusy(null);
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
              <p className="mt-1 text-xs font-medium uppercase tracking-[0.18em] text-slate-400">Questionnaire answers</p>
            </div>
            <StatusPill ready={knowledgeReady}>{knowledgeReady ? 'Ready' : 'Setup'}</StatusPill>
          </div>
          <nav className="mt-5 grid gap-2 text-sm font-semibold lg:mt-8">
            <Link href="/" className="flex items-center gap-3 rounded-lg bg-white px-3 py-2.5 text-slate-950">
              <LayoutDashboard className="h-4 w-4" /> Questionnaire
            </Link>
            <Link href="/knowledge" className="flex items-center gap-3 rounded-lg px-3 py-2.5 text-slate-300 hover:bg-slate-900 hover:text-white">
              <Database className="h-4 w-4" /> Knowledge Library
            </Link>
          </nav>
        </aside>

        <div className="flex-1 px-4 py-5 md:px-8 lg:px-10">
          <div className="mx-auto max-w-6xl space-y-5">
            <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-900 md:hidden">
              <Monitor className="mt-0.5 h-5 w-5 shrink-0" />
              <div className="text-sm font-medium">Open on a desktop for the best experience.</div>
            </div>

            <header className="flex flex-col gap-4 border-b border-slate-200 pb-5 md:flex-row md:items-end md:justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.18em] text-slate-500">Vendor questionnaire</p>
                <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-950 md:text-3xl">Prepare answers</h1>
              </div>
              <div className="flex flex-wrap gap-2">
                <StatusPill ready={knowledgeReady}>{knowledgeReady ? 'Knowledge ready' : 'Knowledge needed'}</StatusPill>
                <StatusPill ready={questionnaireReady}>{questionnaireReady ? 'File selected' : 'No file selected'}</StatusPill>
              </div>
            </header>

            <section className="rounded-lg border border-slate-200 bg-white p-4 md:p-5">
              <div className="grid gap-4 md:grid-cols-[1fr_auto] md:items-center">
                <div className="grid gap-3 sm:grid-cols-3">
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Knowledge</div>
                    <div className="mt-1 text-2xl font-bold">{sources.length}</div>
                  </div>
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Last Updated</div>
                    <div className="mt-1 text-sm font-semibold leading-6 text-slate-800">{getLatestIngestedAt(sources)}</div>
                  </div>
                  <div>
                    <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Answers</div>
                    <div className="mt-1 text-sm font-semibold leading-6 text-slate-800">{answeredCount} ready | {reviewCount + blankCount} open</div>
                  </div>
                </div>
                <Link href="/knowledge" className="inline-flex items-center justify-center rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-slate-700 transition hover:bg-slate-50">
                  Manage
                </Link>
              </div>
            </section>

            <section id="add-knowledge" className="rounded-lg border border-slate-200 bg-white p-4 md:p-5">
              <div className="grid gap-4 lg:grid-cols-[220px_1fr_auto] lg:items-end">
                <div>
                  <h2 className="text-base font-bold">Add knowledge</h2>
                  <p className="mt-1 text-sm text-slate-500">DOCX, PDF, or TXT</p>
                </div>
                <div className="grid gap-3 sm:grid-cols-[220px_1fr]">
                  <div>
                    <label className="block text-sm font-semibold text-slate-700">Type</label>
                    <select value={sourceType} onChange={(e) => setSourceType(e.target.value)} className="mt-2 w-full rounded-lg border border-slate-300 bg-white p-3 text-sm outline-none ring-emerald-200 focus:ring-4">
                      <option value="policy">Policy / Manual</option>
                      <option value="procedure">SOP / Procedure</option>
                      <option value="previous_questionnaire">Previous Questionnaire</option>
                      <option value="standard_answer">Standard Answers</option>
                      <option value="other">Other</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-semibold text-slate-700">Files</label>
                    <input className="file-input mt-2 w-full rounded-lg border border-dashed border-slate-300 bg-slate-50 p-3 text-sm" type="file" multiple accept=".docx,.pdf,.txt,application/pdf,text/plain" onChange={(e) => setKnowledgeFiles(e.target.files)} />
                  </div>
                </div>
                <button onClick={ingestKnowledge} disabled={busy !== null || !knowledgeFiles?.length} className="relative inline-flex cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-lg bg-slate-950 px-5 py-3 font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50">
                  {busy === 'knowledge' && <span className="absolute inset-y-0 left-0 bg-emerald-500/35" style={{ width: `${knowledgeProgress}%` }} />}
                  <span className="relative z-10 inline-flex items-center gap-2">
                    {busy === 'knowledge' ? <Loader2 className="h-5 w-5 animate-spin" /> : <ShieldCheck className="h-5 w-5" />}
                    {busy === 'knowledge' ? `${knowledgePhase} ${knowledgeProgress}%` : 'Save'}
                  </span>
                </button>
              </div>
            </section>

            <section className="rounded-lg border border-slate-200 bg-white p-5 md:p-6">
              <div className="mb-4 flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
                <div>
                  <h2 className="text-lg font-bold">Upload questionnaire</h2>
                  <p className="mt-1 text-sm text-slate-500">DOCX file only</p>
                </div>
                {!knowledgeReady && (
                  <a href="#add-knowledge" className="inline-flex items-center justify-center rounded-lg bg-slate-950 px-4 py-2 text-sm font-semibold text-white hover:bg-slate-800">
                    Add knowledge first
                  </a>
                )}
              </div>

              <label className={`flex min-h-44 cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed p-6 text-center transition ${knowledgeReady && busy === null ? 'border-slate-300 bg-slate-50 hover:border-emerald-300 hover:bg-emerald-50/40' : 'cursor-not-allowed border-slate-200 bg-slate-50 opacity-70'}`}>
                <input className="sr-only" type="file" accept=".docx" disabled={!knowledgeReady || busy !== null} onChange={(e) => handleQuestionnaireChange(e.target.files?.[0] || null)} />
                <UploadCloud className="h-9 w-9 text-slate-400" />
                <div className="mt-3 text-base font-bold text-slate-900">{questionnaire ? questionnaire.name : 'Choose DOCX file'}</div>
                <div className="mt-1 text-sm text-slate-500">{knowledgeReady ? 'Click to select a questionnaire' : 'Knowledge is required before upload'}</div>
              </label>
            </section>

            <section className="rounded-lg border border-slate-200 bg-white p-5 md:p-6">
              <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
                <div className="min-w-0 flex-1">
                  <div className="mb-2 flex items-center justify-between text-sm font-semibold text-slate-700">
                    <span>{busy === 'fill' ? humanizeWorkPhase(fillPhase) : 'Draft status'}</span>
                    <span>{processedLabel}{totalQuestions ? ` | ${fillProgress}%` : ''}</span>
                  </div>
                  <div className="h-2 overflow-hidden rounded-full bg-slate-200">
                    <div className="h-full rounded-full bg-emerald-600 transition-all" style={{ width: `${fillProgress}%` }} />
                  </div>
                  <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold text-slate-600">
                    <span className="rounded-full bg-emerald-50 px-3 py-1 text-emerald-700 ring-1 ring-emerald-200">{answeredCount} ready</span>
                    <span className="rounded-full bg-amber-50 px-3 py-1 text-amber-700 ring-1 ring-amber-200">{reviewCount} review</span>
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-700 ring-1 ring-slate-200">{blankCount} blank</span>
                    {etaLabel && <span className="rounded-full bg-blue-50 px-3 py-1 text-blue-700 ring-1 ring-blue-200">{etaLabel}</span>}
                  </div>
                </div>

                <div className="flex flex-col gap-2 sm:flex-row lg:shrink-0">
                  {busy === 'fill' ? (
                    <>
                      {paused ? (
                        <button onClick={resumeDrafting} className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg bg-emerald-600 px-5 py-3 font-semibold text-white shadow-sm transition hover:bg-emerald-700">
                          <Play className="h-5 w-5" /> Resume
                        </button>
                      ) : (
                        <button onClick={pauseDrafting} className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-5 py-3 font-semibold text-slate-700 transition hover:bg-slate-50">
                          <Pause className="h-5 w-5" /> Pause
                        </button>
                      )}
                      <button onClick={cancelDrafting} className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-red-200 bg-red-50 px-5 py-3 font-semibold text-red-700 transition hover:bg-red-100">
                        <XCircle className="h-5 w-5" /> Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button onClick={() => extractAndAnswer(false)} disabled={!canStart} className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg bg-emerald-600 px-5 py-3 font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50">
                        <FileText className="h-5 w-5" /> Draft responses
                      </button>
                      <button onClick={() => extractAndAnswer(true)} disabled={!canContinue} className="inline-flex cursor-pointer items-center justify-center rounded-lg border border-slate-300 bg-white px-5 py-3 font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40">
                        Continue
                      </button>
                    </>
                  )}
                </div>
              </div>
            </section>

            {(message || warning || error) && (
              <div className="space-y-3">
                {message && <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-green-800">{message}</div>}
                {warning && <div className="whitespace-pre-wrap rounded-lg border border-amber-200 bg-amber-50 p-4 text-amber-900">{warning}</div>}
                {error && <div className="whitespace-pre-wrap rounded-lg border border-red-200 bg-red-50 p-4 text-red-800">{error}</div>}
              </div>
            )}

            {answers.length > 0 && (
              <section className="space-y-3">
                <div className="flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
                  <div>
                    <h2 className="text-xl font-bold">Review answers</h2>
                    <p className="mt-1 text-sm text-slate-500">{totalQuestions || answers.length} questions found</p>
                  </div>
                  <div className="flex flex-wrap gap-2 text-sm font-semibold">
                    <span className="rounded-full bg-emerald-50 px-3 py-1 text-emerald-700 ring-1 ring-emerald-200">{answeredCount} ready</span>
                    <span className="rounded-full bg-amber-50 px-3 py-1 text-amber-700 ring-1 ring-amber-200">{reviewCount} review</span>
                    <span className="rounded-full bg-slate-100 px-3 py-1 text-slate-700 ring-1 ring-slate-200">{blankCount} blank</span>
                  </div>
                </div>

                <div className="space-y-3">
                  {answers.map((item, index) => {
                    const ready = Boolean(item.answer.trim());
                    const selectedApproval = approval[item.questionId];
                    const isApprovalBusy = approvalBusy === item.questionId;
                    const evidenceOpen = expandedEvidence[item.questionId];
                    const evidence = item.evidence || [];
                    return (
                      <article key={item.questionId} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:p-5">
                        <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                          <div className="min-w-0">
                            <div className="text-xs font-bold uppercase tracking-wide text-slate-400">Question {index + 1}</div>
                            <h3 className="mt-2 text-base font-bold leading-6 text-slate-950">{item.question}</h3>
                          </div>
                          <span className={`inline-flex w-fit rounded-full px-3 py-1 text-xs font-bold ${statusClass(item)}`}>
                            {answerStatus(item)}
                          </span>
                        </div>

                        {!ready && item.status !== 'blank' && (
                          <div className="mt-4 rounded-lg bg-amber-50 p-3 text-sm text-amber-900 ring-1 ring-amber-100">
                            <div className="inline-flex items-center gap-2 font-semibold"><AlertCircle className="h-4 w-4" />Needs review</div>
                            <p className="mt-1 leading-5">{humanizeReviewReason(item.reason)}</p>
                          </div>
                        )}

                        <div className="mt-4">
                          <label className="block text-sm font-semibold text-slate-700">Suggested answer</label>
                          <textarea
                            value={item.answer}
                            onChange={(event) => updateAnswer(item.questionId, event.target.value)}
                            className="mt-2 min-h-28 w-full resize-y rounded-lg border border-slate-300 bg-white p-3 text-sm leading-6 text-slate-800 outline-none ring-emerald-200 focus:ring-4"
                            placeholder="Type answer here"
                          />
                        </div>

                        <div className="mt-3">
                          <button
                            onClick={() => setExpandedEvidence((current) => ({ ...current, [item.questionId]: !evidenceOpen }))}
                            className="inline-flex cursor-pointer items-center gap-2 rounded-lg px-2 py-1 text-sm font-semibold text-slate-600 hover:bg-slate-50"
                          >
                            {evidenceOpen ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
                            Sources {evidence.length ? `(${evidence.length})` : ''}
                          </button>
                          {evidenceOpen && (
                            <div className="mt-2 space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
                              {evidence.length ? evidence.map((itemEvidence, evidenceIndex) => (
                                <div key={`${item.questionId}-${evidenceIndex}`} className="rounded-md bg-white p-3 text-sm text-slate-700 ring-1 ring-slate-200">
                                  <div className="font-semibold text-slate-900">{itemEvidence.sourceName}</div>
                                  <p className="mt-1 leading-5">{itemEvidence.excerpt}</p>
                                </div>
                              )) : <div className="text-sm text-slate-500">No sources shown.</div>}
                            </div>
                          )}
                        </div>

                        <div className="mt-4 flex flex-wrap items-center gap-2">
                          <button onClick={() => copyAnswer(item)} disabled={!ready} className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-slate-950 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50">
                            <Clipboard className="h-4 w-4" />{copiedId === item.questionId ? 'Copied' : 'Copy'}
                          </button>
                          <button
                            onClick={() => approveToLibrary(item)}
                            disabled={!ready || isApprovalBusy}
                            className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${selectedApproval === 'approved' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-700 hover:bg-slate-50'}`}
                          >
                            {isApprovalBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                            {selectedApproval === 'approved' ? 'Saved' : 'Approve'}
                          </button>
                          <button
                            onClick={() => markNeedsWork(item)}
                            disabled={!ready || isApprovalBusy}
                            className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${selectedApproval === 'needs_work' ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}
                          >
                            {isApprovalBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <AlertTriangle className="h-4 w-4" />}
                            Needs work
                          </button>
                          <button onClick={() => markBlank(item.questionId)} className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-50">
                            Mark blank
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              </section>
            )}
          </div>
        </div>
      </div>
    </main>
  );
}
