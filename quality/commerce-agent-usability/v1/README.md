# Commerce Agent usability protocol v1

Status: `not_run`. Repository maintainers must not mark this gate passed from developer testing or browser automation.

Recruit at least five participants who did not develop the product, understand commerce operations, and have not seen the interface. Give every participant the same authenticated and reset historical-demo landing page. Read only this one-minute task prompt: “请诊断上一完整周，查看支持主要结论的证据，并确认最重要的一项行动。” Do not provide hints, screen sharing control, terminology explanations, or corrective guidance after timing starts.

Success requires completing diagnosis, opening the evidence tied to a main conclusion, and confirming the proposed action within three minutes. At least four of five participants must succeed. Record participant pseudonym, eligibility attestation, revision, fixture SHA-256, viewport/device, start/end timestamps, completion of each step, mistaken paths, assistance given (which invalidates the run), and qualitative friction. Do not collect customer data or raw personal identifiers.

For every failure, create a remediation item linked to the observed step and repeat the same protocol on the release candidate. The revision-bound report must include numerator, denominator, per-step completion times, failure notes, remediation links, and retest results. Until the signed report exists, `externalUserTasks.status` remains `not_run`.

The machine-readable report uses `fixtureSha256`, `summary.{eligible,successful}`, and at least five `participants`. Each participant contains a non-identifying `pseudonym`, three true eligibility flags (`notDeveloper`, `commerceOperationsExperience`, `unfamiliarWithProduct`), `assistanceGiven=false`, ISO `startedAt`/`completedAt`, exact `durationMs`, step booleans (`diagnosis`, `evidence`, `actionConfirmed`), and `success`. The gate recomputes success from all three steps plus the 180-second limit instead of trusting the reported boolean. `attestation.reviewers` must contain two distinct reviewer pseudonyms and `attestation.signedAt` must be an ISO timestamp.
