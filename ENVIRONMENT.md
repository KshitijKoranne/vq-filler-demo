Create these variables in your deployment provider:

- TURSO_DATABASE_URL
- TURSO_AUTH_TOKEN
- NVIDIA_API_KEY
- TRIAL_EXPIRES_AT, required in production, ISO timestamp such as `2026-09-17T23:59:59.000Z`
- TRIAL_CLIENT_NAME, optional display name for the client trial
- TRIAL_SUPPORT_EMAIL, optional contact email shown on the expired-trial page
- NVIDIA_BASE_URL, optional, default: https://integrate.api.nvidia.com/v1
- NVIDIA_CHAT_MODEL, optional, default: meta/llama-3.1-70b-instruct
- NVIDIA_EMBEDDING_MODEL, optional, default: nvidia/llama-nemotron-embed-1b-v2
- EMBEDDING_DIMENSIONS, optional, default: 2048
- MIN_ANSWER_CONFIDENCE, optional, default: 0.25
- MIN_RETRIEVAL_SIMILARITY, optional, default: 0.35
- FILL_DEBUG, optional, set to true for retrieval diagnostics
- ADMIN_HEALTH_TOKEN, optional, requires `Authorization: Bearer <token>` for `/api/health` when set

Never commit real keys or tokens to this repository.

The default embedding model is expected to return 2048-dimensional vectors for Turso `F32_BLOB(2048)` storage. If you change `NVIDIA_EMBEDDING_MODEL` or `EMBEDDING_DIMENSIONS`, reingest or re-embed existing knowledge chunks.

For client trials, create a separate Turso database per client and set `TRIAL_EXPIRES_AT` to the end of the approved trial window. The expiry check is enforced server-side in production pages and API routes. It is not a substitute for keeping source code, deployment access, and environment variables private.

Important: if you accidentally paste a token into chat, terminal logs, GitHub, screenshots, or any public/private issue where others or tools may access it, revoke it and create a fresh token.
