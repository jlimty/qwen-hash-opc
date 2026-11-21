---
name: tender-desk-connection-check
description: Use when asked to run the Tender Desk skill check or verify the local Tender Desk MCP connection in QwenWork.
---

# Tender Desk Connection Check

Verify the existing local connector through a real, read-only tool call. Do not perform tender analysis or business actions.

## Steps

1. Announce: "Using tender-desk-connection-check."
2. Use the nonce supplied in the current request. Require 1–64 characters matching `^[A-Za-z0-9_-]{1,64}$`. If absent or invalid, ask for a fresh valid nonce and stop without calling tools; do not silently change it.
3. Find `health_check` belonging to the configured `tender-desk-smoke` connector in the available tool catalog. Use the actual exposed tool identifier, including its namespace if present; do not invent one. If unavailable, report that and stop.
4. Call that tool once with the sole argument `nonce` set to the user's nonce. Wait for the actual result. If permission is denied, authentication fails, the call times out, or the tool reports an error, report the failure without claiming success or retrying.
5. Read the JSON from the tool's text result. Report success only if this call returned `status` equal to `ok`, `service` equal to `tender-desk-smoke`, the exact requested `nonce`, and a valid ISO 8601 `checked_at` timestamp. Treat missing or mismatched fields as an unsuccessful check. Never substitute an earlier result or generate a result yourself.
6. Show the returned JSON, then state either "Local connector check passed" or the specific failure. If no result was received, say so instead of constructing JSON. Redact any credentials if unexpectedly present in a response or error.

## Boundaries

- Rely on authentication already configured in the connector. Never request, read, display, or copy tokens, headers, credential files, or configuration files.
- Do not use shell commands, direct HTTP requests, another connector, or simulated responses as a substitute for the MCP tool.
- Do not change connector settings, install software, or write data.
- A successful local call does not verify hosted HTTPS, scheduling, business guardrails, or production readiness.
