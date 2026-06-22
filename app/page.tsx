'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import {
  AlertCircle,
  Database,
  CheckCircle2,
  Clipboard,
  FileText,
  LayoutDashboard,
  Loader2,
  ShieldCheck,
  ThumbsDown,
  ThumbsUp,
  UploadCloud,
} from 'lucide-react';
import type { GeneratedAnswer, KnowledgeSourceSummary, QuestionCandidate } from '@/lib/types';

async function readApiResponse(response: Response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    return { error: text || `Request failed with status ${response.status}` };
  }
}

function delay(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function isRateLimitedAnswer(answer: GeneratedAnswer) {
  return /rate limit|429|too many requests|quota/i.test(answer.reason || '');
}

type KnowledgeStreamEvent =
  | { type: 'progress'; phase: string; progress: number; fileName?: string; insertedChunks?: number; totalChunks?: number }
  | { type: 'complete'; progress: number; totalChunks: number; sources: { fileName: string; chunks: number; warnings?: string[] }[]; skipped: { fileName: string; reason: string }[] }
  | { type: 'error'; error: string; skipped?: { fileName: string; reason: string }[] };

type ExtractResponse = { totalQuestions: number; questions: QuestionCandidate[] };
type AnswerResponse = { answer: GeneratedAnswer };
type FeedbackVote = 'up' | 'down';

function humanizeKnowledgePhase(phase: string) {
  if (/complete|built|ingested/i.test(phase)) return 'Knowledge ready';
  if (/starting/i.test(phase)) return 'Preparing files';
  if (/embedding|chunk|vector|ingestion/i.test(phase)) return 'Processing files';
  return phase.replace(/chunks?/gi, 'sections');
}

function humanizeWorkPhase(phase: string) {
  if (/extract/i.test(phase)) return 'Reading questionnaire';
  if (/answering|drafting/i.test(phase)) return phase.replace('Answering', 'Drafting');
  if (/waiting/i.test(phase)) return phase.replace('before next request', 'before next answer');
  if (/resuming/i.test(phase)) return 'Continuing';
  return phase;
}

function humanizeReviewReason(reason?: string) {
  if (!reason) return 'Requires manual confirmation.';
  if (/rate limit|429|too many requests|quota/i.test(reason)) return 'Service was busy. Review manually or retry later.';
  if (/confidence|similarity|retrieval|source|evidence|not found|insufficient/i.test(reason)) return 'Source support was not strong enough.';
  if (/timeout|failed|error/i.test(reason)) return 'Could not complete safely. Review manually.';
  return 'Requires manual confirmation.';
}

function statusLabel(status: GeneratedAnswer['status']) {
  if (status === 'answered') return 'Ready';
  if (status === 'review') return 'Review';
  return 'Open';
}

function StatusPill({ ready, children }: { ready: boolean; children: React.ReactNode }) {
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${ready ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200' : 'bg-slate-100 text-slate-600 ring-1 ring-slate-200'}`}>
      {ready ? <CheckCircle2 className="h-3.5 w-3.5" /> : <span className="h-2 w-2 rounded-full bg-slate-400" />}
      {children}
    </span>
  );
}

export default function HomePage() {
  const [knowledgeFiles, setKnowledgeFiles] = useState<FileList | null>(null);
  const [sourceType, setSourceType] = useState('policy');
  const [questionnaire, setQuestionnaire] = useState<File | null>(null);
  const [sources, setSources] = useState<KnowledgeSourceSummary[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [knowledgeProgress, setKnowledgeProgress] = useState(0);
  const [knowledgePhase, setKnowledgePhase] = useState('Preparing files');
  const [fillProgress, setFillProgress] = useState(0);
  const [fillPhase, setFillPhase] = useState('Ready');
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answers, setAnswers] = useState<GeneratedAnswer[]>([]);
  const [totalQuestions, setTotalQuestions] = useState(0);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, FeedbackVote>>({});
  const [feedbackBusy, setFeedbackBusy] = useState<string | null>(null);

  const answeredCount = useMemo(() => answers.filter((answer) => answer.status === 'answered').length, [answers]);
  const reviewCount = useMemo(() => answers.filter((answer) => answer.status !== 'answered').length, [answers]);
  const pendingCount = Math.max((totalQuestions || 0) - answers.length, 0);
  const knowledgeReady = sources.length > 0;
  const questionnaireReady = Boolean(questionnaire);
  const canStart = knowledgeReady && questionnaireReady && busy === null;
  const canContinue = Boolean(questionnaire && answers.length > 0 && busy === null);

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
    if (!knowledgeFiles?.length) return setError('Select at least one knowledge file.');
    setBusy('knowledge');
    setKnowledgeProgress(1);
    setKnowledgePhase('Preparing files');
    setError(null);
    setMessage(null);

    try {
      const form = new FormData();
      Array.from(knowledgeFiles).forEach((file) => form.append('files', file));
      form.append('sourceType', sourceType);

      const response = await fetch('/api/knowledge', { method: 'POST', body: form });
      if (!response.ok || !response.body) {
        const data = await readApiResponse(response);
        return setError(data.error || 'Could not save knowledge.');
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
          setKnowledgePhase('Knowledge ready');
          const warningLines = event.sources.flatMap((source) => (source.warnings || []).map((warning) => `${source.fileName}: ${warning}`));
          setMessage(`${event.sources.length} file(s) added to the knowledge library.${event.skipped.length ? ` ${event.skipped.length} file(s) skipped.` : ''}`);
          if (event.skipped.length || warningLines.length) {
            setError([...warningLines, ...event.skipped.map((item) => `${item.fileName}: ${item.reason}`)].join('\n'));
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
      setError(err instanceof Error ? err.message : 'Could not save knowledge.');
    } finally {
      setBusy(null);
      setKnowledgePhase('Preparing files');
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

    setBusy('fill');
    setFillProgress(existingAnswers.length ? fillProgress : 1);
    setFillPhase(continueMode ? 'Continuing' : 'Reading questionnaire');
    setError(null);
    setMessage(null);
    if (!continueMode) {
      setAnswers([]);
      setTotalQuestions(0);
      setFeedback({});
    }

    try {
      const requestDelayMs = 8000;
      const rateLimitDelayMs = 90000;
      const extracted = await extractQuestions(questionnaire);
      const questions = extracted.questions;
      const startIndex = Math.min(existingAnswers.length, questions.length);
      setTotalQuestions(extracted.totalQuestions);

      const allAnswers: GeneratedAnswer[] = [...existingAnswers];
      for (let index = startIndex; index < questions.length; index++) {
        const question = questions[index];
        setFillPhase(`Drafting ${index + 1} of ${questions.length}`);
        const answer = await answerOneQuestion(question);
        allAnswers.push(answer);
        setAnswers([...allAnswers]);
        setFillProgress(Math.min(100, Math.round((allAnswers.length / questions.length) * 100)));
        if (index < questions.length - 1) {
          const waitMs = isRateLimitedAnswer(answer) ? rateLimitDelayMs : requestDelayMs;
          const waitSec = Math.round(waitMs / 1000);
          setFillPhase(`Waiting ${waitSec}s before next answer (${allAnswers.length}/${questions.length})`);
          await delay(waitMs);
        }
      }

      const answered = allAnswers.filter((a) => a.status === 'answered').length;
      setMessage(`Completed. ${answered} ready, ${allAnswers.length - answered} marked for review.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Drafting stopped. You can continue from the last completed answer.');
    } finally {
      setBusy(null);
      setFillPhase('Ready');
    }
  }

  async function copyAnswer(answer: GeneratedAnswer) {
    if (!answer.answer) return;
    await navigator.clipboard.writeText(answer.answer);
    setCopiedId(answer.questionId);
    window.setTimeout(() => setCopiedId(null), 1200);
  }

  async function submitFeedback(answer: GeneratedAnswer, vote: FeedbackVote) {
    if (!answer.answer || feedbackBusy) return;
    setFeedbackBusy(answer.questionId);
    setError(null);

    try {
      const response = await fetch('/api/answers/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          questionId: answer.questionId,
          question: answer.question,
          answer: answer.answer,
          vote,
          reason: vote === 'down' ? answer.reason || 'Marked for improvement' : undefined,
        }),
      });
      const data = await readApiResponse(response);
      if (!response.ok) return setError(data.error || 'Could not save feedback.');
      setFeedback((current) => ({ ...current, [answer.questionId]: vote }));
      if (vote === 'up') await loadSources();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save feedback.');
    } finally {
      setFeedbackBusy(null);
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
          <div className="mt-6 hidden rounded-lg border border-slate-800 bg-slate-900/70 p-3 text-xs leading-5 text-slate-300 lg:block">
            Draft from controlled knowledge only. Unsupported responses remain open for QA review.
          </div>
        </aside>

        <div className="flex-1 px-4 py-5 md:px-8 lg:px-10">
          <div className="mx-auto max-w-7xl space-y-5">
            <header className="flex flex-col gap-4 border-b border-slate-200 pb-5 md:flex-row md:items-end md:justify-between">
              <div>
                <p className="text-xs font-bold uppercase tracking-[0.18em] text-slate-500">Vendor questionnaire control</p>
                <h1 className="mt-2 text-2xl font-bold tracking-tight text-slate-950 md:text-3xl">Draft responses from approved QA knowledge</h1>
                <p className="mt-2 max-w-2xl text-sm text-slate-600">Add controlled documents, match each question to source evidence, and review every response before use.</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <StatusPill ready={knowledgeReady}>{knowledgeReady ? `${sources.length} source${sources.length === 1 ? '' : 's'}` : 'Knowledge required'}</StatusPill>
                <StatusPill ready={questionnaireReady}>{questionnaireReady ? 'DOCX selected' : 'DOCX required'}</StatusPill>
              </div>
            </header>

            <section className="grid gap-3 md:grid-cols-4">
              <div className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Knowledge</div>
                <div className="mt-2 text-2xl font-bold">{sources.length}</div>
                <div className="mt-1 text-xs text-slate-500">approved sources</div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Ready</div>
                <div className="mt-2 text-2xl font-bold text-emerald-700">{answeredCount}</div>
                <div className="mt-1 text-xs text-slate-500">responses drafted</div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Review</div>
                <div className="mt-2 text-2xl font-bold text-amber-700">{reviewCount}</div>
                <div className="mt-1 text-xs text-slate-500">need QA review</div>
              </div>
              <div className="rounded-lg border border-slate-200 bg-white p-4">
                <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">Open</div>
                <div className="mt-2 text-2xl font-bold text-slate-700">{pendingCount}</div>
                <div className="mt-1 text-xs text-slate-500">remaining questions</div>
              </div>
            </section>

        <section className="grid gap-4 lg:grid-cols-[0.9fr_1.1fr]">
          <div className="rounded-lg border border-slate-200 bg-white p-5">
            <div className="mb-5 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-bold">Add knowledge</h2>
                <p className="mt-1 text-sm text-slate-500">Controlled DOCX, PDF, or TXT files used as source material.</p>
              </div>
              <UploadCloud className="h-6 w-6 text-slate-400" />
            </div>
            <label className="block text-sm font-semibold text-slate-700">Category</label>
            <select value={sourceType} onChange={(e) => setSourceType(e.target.value)} className="mt-2 w-full rounded-lg border border-slate-300 bg-white p-3 text-sm outline-none ring-emerald-200 focus:ring-4">
              <option value="policy">Policy / Manual</option>
              <option value="procedure">SOP / Procedure</option>
              <option value="previous_questionnaire">Previous questionnaire</option>
              <option value="standard_answer">Standard answer bank</option>
              <option value="other">Other</option>
            </select>
            <input className="file-input mt-4 w-full rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-sm" type="file" multiple accept=".docx,.pdf,.txt,application/pdf,text/plain" onChange={(e) => setKnowledgeFiles(e.target.files)} />
            <button onClick={ingestKnowledge} disabled={busy !== null || !knowledgeFiles?.length} className="relative mt-4 inline-flex w-full cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-lg bg-slate-950 px-5 py-3 font-semibold text-white shadow-sm transition hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-50">
              {busy === 'knowledge' && <span className="absolute inset-y-0 left-0 bg-emerald-500/35" style={{ width: `${knowledgeProgress}%` }} />}
              <span className="relative z-10 inline-flex items-center gap-2">
                {busy === 'knowledge' ? <Loader2 className="h-5 w-5 animate-spin" /> : <ShieldCheck className="h-5 w-5" />}
                {busy === 'knowledge' ? `${humanizeKnowledgePhase(knowledgePhase)} ${knowledgeProgress}%` : 'Save to library'}
              </span>
            </button>
          </div>

          <div className="rounded-lg border border-slate-200 bg-white p-5">
            <div className="mb-5 flex items-start justify-between gap-3">
              <div>
                <h2 className="text-base font-bold">Questionnaire drafting</h2>
                <p className="mt-1 text-sm text-slate-500">Select the received DOCX file and prepare reviewable drafts.</p>
              </div>
              <FileText className="h-6 w-6 text-slate-400" />
            </div>

            <input className="file-input w-full rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4 text-sm disabled:opacity-50" type="file" accept=".docx" disabled={!knowledgeReady || busy !== null} onChange={(e) => setQuestionnaire(e.target.files?.[0] || null)} />
            {questionnaire && <p className="mt-3 rounded-lg bg-slate-50 p-3 text-sm font-medium text-slate-700">{questionnaire.name}</p>}

            <div className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-4">
              <div className="mb-2 flex items-center justify-between text-sm font-semibold text-slate-700">
                <span>{busy === 'fill' ? humanizeWorkPhase(fillPhase) : 'Drafting status'}</span>
                <span>{fillProgress}%</span>
              </div>
              <div className="h-2 overflow-hidden rounded-full bg-slate-200">
                <div className="h-full rounded-full bg-blue-600 transition-all" style={{ width: `${fillProgress}%` }} />
              </div>
              <div className="mt-4 grid grid-cols-3 gap-2 text-center text-xs font-semibold text-slate-600">
                <div className="rounded-lg bg-white p-3 ring-1 ring-slate-200"><div className="text-xl text-emerald-700">{answeredCount}</div>Ready</div>
                <div className="rounded-lg bg-white p-3 ring-1 ring-slate-200"><div className="text-xl text-amber-700">{reviewCount}</div>Review</div>
                <div className="rounded-lg bg-white p-3 ring-1 ring-slate-200"><div className="text-xl text-slate-500">{pendingCount}</div>Open</div>
              </div>
            </div>

            <div className="mt-5 flex flex-col gap-3 sm:flex-row">
              <button onClick={() => extractAndAnswer(false)} disabled={!canStart} className="relative inline-flex flex-1 cursor-pointer items-center justify-center gap-2 overflow-hidden rounded-lg bg-emerald-600 px-5 py-3 font-semibold text-white shadow-sm transition hover:bg-emerald-700 disabled:cursor-not-allowed disabled:opacity-50">
                {busy === 'fill' && <span className="absolute inset-y-0 left-0 bg-white/25" style={{ width: `${fillProgress}%` }} />}
                <span className="relative z-10 inline-flex items-center gap-2">{busy === 'fill' ? <Loader2 className="h-5 w-5 animate-spin" /> : <FileText className="h-5 w-5" />}{busy === 'fill' ? 'Drafting' : 'Draft responses'}</span>
              </button>
              <button onClick={() => extractAndAnswer(true)} disabled={!canContinue} className="inline-flex cursor-pointer items-center justify-center rounded-lg border border-slate-300 bg-white px-5 py-3 font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40">
                Continue
              </button>
            </div>
          </div>
        </section>

        {(message || error) && (
          <div className="space-y-3">
            {message && <div className="rounded-lg border border-green-200 bg-green-50 p-4 text-green-800">{message}</div>}
            {error && <div className="whitespace-pre-wrap rounded-lg border border-red-200 bg-red-50 p-4 text-red-800">{error}</div>}
          </div>
        )}

        {answers.length > 0 && (
          <section className="rounded-lg border border-slate-200 bg-white p-5 md:p-6">
            <div className="mb-5 flex flex-col gap-3 md:flex-row md:items-end md:justify-between">
              <div>
                <h2 className="text-2xl font-bold">Answer review</h2>
                <p className="mt-1 text-sm text-slate-500">{totalQuestions || answers.length} questions detected</p>
              </div>
              <div className="flex flex-wrap gap-2 text-sm font-semibold">
                <span className="rounded-full bg-emerald-50 px-3 py-1 text-emerald-700 ring-1 ring-emerald-200">{answeredCount} ready</span>
                <span className="rounded-full bg-amber-50 px-3 py-1 text-amber-700 ring-1 ring-amber-200">{reviewCount} review</span>
              </div>
            </div>

            <div className="overflow-x-auto rounded-lg border border-slate-200">
              <table className="w-full min-w-[900px] border-collapse text-sm">
                <thead className="bg-slate-50 text-left text-slate-600">
                  <tr>
                    <th className="w-14 p-4">#</th>
                    <th className="w-[34%] p-4">Question</th>
                    <th className="p-4">Suggested answer</th>
                    <th className="w-32 p-4">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {answers.map((item, index) => {
                    const ready = item.status === 'answered' && Boolean(item.answer);
                    const selectedFeedback = feedback[item.questionId];
                    const isFeedbackBusy = feedbackBusy === item.questionId;
                    return (
                      <tr key={item.questionId} className="border-t border-slate-200 align-top">
                        <td className="p-4 font-semibold text-slate-400">{index + 1}</td>
                        <td className="p-4 font-medium leading-6 text-slate-900">{item.question}</td>
                        <td className="p-4 text-slate-700">
                          {ready ? (
                            <div className="space-y-3">
                              <p className="leading-6">{item.answer}</p>
                              <div className="flex flex-wrap items-center gap-2">
                                <button onClick={() => copyAnswer(item)} className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-slate-950 px-3 py-2 text-sm font-semibold text-white shadow-sm hover:bg-slate-800">
                                  <Clipboard className="h-4 w-4" />{copiedId === item.questionId ? 'Copied ✓' : 'Copy answer'}
                                </button>
                                <button
                                  onClick={() => submitFeedback(item, 'up')}
                                  disabled={isFeedbackBusy}
                                  className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${selectedFeedback === 'up' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}
                                  aria-label="Mark answer as useful"
                                >
                                  {isFeedbackBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ThumbsUp className="h-4 w-4" />}
                                </button>
                                <button
                                  onClick={() => submitFeedback(item, 'down')}
                                  disabled={isFeedbackBusy}
                                  className={`inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${selectedFeedback === 'down' ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-slate-200 text-slate-600 hover:bg-slate-50'}`}
                                  aria-label="Mark answer for improvement"
                                >
                                  {isFeedbackBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ThumbsDown className="h-4 w-4" />}
                                </button>
                              </div>
                            </div>
                          ) : (
                            <div className="space-y-2 rounded-lg bg-amber-50 p-3 text-amber-900 ring-1 ring-amber-100">
                              <div className="inline-flex items-center gap-2 font-semibold"><AlertCircle className="h-4 w-4" />Review</div>
                              <p className="text-sm leading-5">{humanizeReviewReason(item.reason)}</p>
                            </div>
                          )}
                        </td>
                        <td className="p-4">
                          <span className={`inline-flex rounded-full px-3 py-1 text-xs font-bold ${ready ? 'bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200' : 'bg-amber-50 text-amber-700 ring-1 ring-amber-200'}`}>
                            {statusLabel(item.status)}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>
        )}
          </div>
        </div>
      </div>
    </main>
  );
}
