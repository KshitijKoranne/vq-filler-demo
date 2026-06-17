# VQ Desk Demo

Hosted demo build of VQ Filler for client walkthroughs and limited trials.

This repository is copied from the private builder project and should stay under your control. Do not give clients this source code, Vercel access, Turso credentials, NVIDIA keys, or deployment secrets.

## What This Demo Does

- Upload approved company knowledge such as SOPs, policies, standard answers, and previous questionnaires.
- Store extracted knowledge chunks in a Turso/libSQL vector database.
- Upload a table-based DOCX vendor/customer questionnaire.
- Detect likely questionnaire rows and answer cells.
- Draft short English answers using only retrieved knowledge snippets.
- Leave unsupported answers blank or marked for review.
- Export a filled DOCX while preserving the original package structure as much as possible.

## Demo Trial Control

This demo includes server-side trial expiry enforcement.

Set `TRIAL_EXPIRES_AT` in the deployment environment to an ISO timestamp such as:

```text
2026-09-17T23:59:59.000Z
```

In production, if `TRIAL_EXPIRES_AT` is missing, invalid, or in the past, the app blocks pages and API routes. This keeps expired client deployments from continuing to process questionnaires or knowledge files.

Important: this protection works only when you host the app and keep the source code and environment variables private. If a client receives the code or deployment credentials, they can bypass any software restriction.

## Per-Client Trial Setup

For each serious client trial:

1. Create a new Turso database for that client.
2. Run `turso/schema.sql` on that database.
3. Create a separate Vercel project or deployment environment for that client.
4. Add client-specific environment variables.
5. Set `TRIAL_CLIENT_NAME` to the client name.
6. Set `TRIAL_EXPIRES_AT` to 90 days from the trial start.
7. Use only sanitized demo data for shared demos. Use client-specific databases for client data.
8. After the trial, either extend `TRIAL_EXPIRES_AT`, convert the client, export/delete the database, or remove the deployment.

## Required Environment Variables

- `TURSO_DATABASE_URL`
- `TURSO_AUTH_TOKEN`
- `NVIDIA_API_KEY` or `NVIDIA_API_KEYS`
- `TRIAL_EXPIRES_AT`

## Optional Environment Variables

- `TRIAL_CLIENT_NAME`
- `TRIAL_SUPPORT_EMAIL`
- `NVIDIA_BASE_URL`, default: `https://integrate.api.nvidia.com/v1`
- `NVIDIA_CHAT_MODEL`, default: `meta/llama-3.1-70b-instruct`
- `NVIDIA_EMBEDDING_MODEL`, default: `nvidia/llama-nemotron-embed-1b-v2`
- `EMBEDDING_DIMENSIONS`, default: `2048`
- `MIN_ANSWER_CONFIDENCE`, default: `0.25`
- `MIN_RETRIEVAL_SIMILARITY`, default: `0.35`
- `FILL_DEBUG`, set `true` for retrieval diagnostics
- `ADMIN_HEALTH_TOKEN`, protects `/api/health` with a bearer token when set

## Local Development

```bash
npm install
npm run dev
```

Local development does not require `TRIAL_EXPIRES_AT`. Production deployments do.

## Verification

```bash
npm run typecheck
npm run lint
npm run build
```

## Operating Rule

The system should never guess. If an answer is not clearly supported by the ingested knowledge base, it remains blank or marked for review.

Evidence is shown only in the app review screen. Evidence is not written into the exported questionnaire.
