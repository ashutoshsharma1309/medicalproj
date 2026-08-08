# AVERIS — security audit

Reviewed against the running system: 14 migrations applied to Postgres 17, 237
RLS assertions executed, the Next.js build inspected for headers, and the
firmware read for credential handling.

> **Scope.** This is an engineering review by the team that wrote the code. It
> is not a penetration test, not a HIPAA/GDPR compliance assessment, and not an
> independent audit. Several findings below are marked as accepted risks; those
> are decisions, not clearances.

---

## Summary

| Area | Result |
|---|---|
| Authentication | Sound — Supabase Auth, JWT re-validated server-side on every request |
| Authorization | Strong — enforced in the database, 237 executed assertions |
| Device authentication | Sound — hashed tokens, owner derived from the device row |
| Transport | **Fixed this pass** — CSP and HSTS were missing; firmware shipped TLS validation off |
| Data exposure in logs | Sound — allowlist redaction, scrubbed twice on the client path |
| Secrets handling | Sound — service-role key isolated to one process, CI scans for committed keys |
| Rate limiting | Adequate — per-operation budgets; see F-6 |

**7 findings. 4 fixed in this pass, 3 accepted and recorded.**

---

## Fixed

### F-1 · No Content-Security-Policy — *high*

`next.config.ts` set `X-Frame-Options`, `nosniff` and a referrer policy, but no
CSP. AVERIS renders vital signs, uploaded medical documents and AI narration;
an injected script on any of those pages could read all of it and post it
anywhere.

**Fixed.** A CSP is now emitted with `connect-src` restricted to `'self'`, the
configured Supabase origin and the configured IoT websocket. That is the
control that matters: even with script execution, exfiltration needs somewhere
to go. `frame-ancestors 'none'`, `object-src 'none'`, `base-uri 'self'` and
`form-action 'self'` are also set.

**Weaker than it looks, deliberately.** `script-src` includes
`'unsafe-inline'`, because Next.js injects an inline bootstrap and inline
flight data on every page. Removing it needs a per-request nonce from
middleware — `proxy.ts` already exists and is the right place. Until then the
policy constrains *where data can go*, not *whether an injected inline script
runs*. Recorded here rather than described as complete.

### F-2 · No HSTS — *medium*

A patient on hospital wifi typing `averis.example` sends the first request in
plaintext, and that request carries a session cookie.

**Fixed.** `Strict-Transport-Security: max-age=31536000; includeSubDomains`.

### F-3 · Firmware example shipped with TLS validation disabled — *high*

`config.example.h` set `AVERIS_TLS_INSECURE 1`. The file people copy is the
file that reaches a ward, and nobody reviews the line they did not have to
change. With validation off, any device on the network can present a
certificate and collect device tokens — a credential that writes into a
patient's chart.

**Fixed.** Defaults to `0`. Enabling it is now a deliberate edit with a comment
explaining what it costs.

### F-4 · Firmware example shipped with serial debug on — *medium*

`AVERIS_SERIAL_DEBUG 1` prints every reading to the UART. On a worn device that
is a vital-sign stream out of a debug port, readable by anything with physical
access.

**Fixed.** Defaults to `0`.

---

## Accepted, and why

### F-5 · `invite_caregiver` reveals whether an email has an account — *low*

Returning `NO_ACCOUNT` is an enumeration oracle: a signed-in patient can test
addresses.

**Accepted.** The alternative is a uniformly vague reply, which means a patient
adding their daughter cannot distinguish a typo from someone who has not signed
up — a silent failure in the flow whose entire purpose is making sure somebody
is watching. Mitigated by a 20/hour rate limit keyed to the patient profile,
and every call is audited. The trade is recorded in the migration that
introduces the function, not just here.

### F-6 · The client-error endpoint is unauthenticated — *low*

`/api/observability/client-error` accepts reports without a session.

**Accepted.** The errors most worth capturing are the ones that break the
session, so requiring one would blind the endpoint to its own reason for
existing. Mitigations: an 8 KB body cap checked before parsing, 60 reports per
10 minutes per IP, a fixed 204 response whatever happens (so it cannot be used
as an oracle), and double sanitisation — the client scrubs, and the server
scrubs again because the client is the component that just crashed.

The IP is read from `x-forwarded-for` and is spoofable behind a proxy. Accepted:
the alternative is no limit at all on an unauthenticated route.

### F-7 · The ingest service holds a service-role key — *by design*

It bypasses RLS entirely.

**Accepted, and structural.** A worker ingesting for a whole fleet cannot be
scoped to one signed-in user. The containment is that it is the only component
holding one, it runs as a separate process from the app serving patient
dashboards, and every write it makes derives `patient_id` from
`private.resolve_device()` rather than from anything the caller sent. That
single-entry-point property is asserted in `device_auth_verification.sql`.

---

## What was verified, not assumed

Executed against Postgres 17 this pass:

- **Patient isolation.** Patient A cannot read patient B's profile, vitals,
  documents, records, insights, predictions or emergencies. Asserted in both
  directions.
- **Doctor scope.** An assigned doctor reads their patient's chart; an
  unassigned one reads nothing. A `PENDING` assignment grants nothing. A
  `REVOKED` one ends access immediately and across every table, not just one.
- **Caregiver scope.** `VIEW_ALERTS` sees emergencies and not a single
  measurement; `VIEW_VITALS` sees measurements and not the medical record;
  `FULL` still cannot read documents or the patient's questions to AVERIS.
- **Privilege escalation.** A doctor cannot assign themselves to a patient, nor
  grant themselves caregiver access, nor write a summary in a colleague's name.
- **Device authentication.** A token resolves to exactly one device and its
  owner; an unknown token resolves to nothing; retiring a device and rotating
  its token both revoke immediately; no client role can call the resolver,
  write a reading, or select `token_hash`.
- **Structural.** Every table in `public` has RLS enabled and at least one
  policy; no policy applies to `PUBLIC`; `anon` holds no table privileges and
  no `USAGE` on `private`; no string-typed token or secret column is selectable
  by a client role.

Two defects were found by running these rather than reading them, and both are
fixed: a missing `UNIQUE` on `iot_devices.token_hash` (F-8 below), and a
patient being unable to read the identity of their own caregiver — which made
the consent page unusable for the one thing it exists to do.

### F-8 · `token_hash` had no unique constraint — *fixed*

`private.resolve_device` is declared `returns table` and `store.py` reads
`rows[0]`. Nothing guaranteed one row.

Not exploitable: a device token is 256 bits of CSPRNG output, and the column is
not readable by any client role, so a deliberate collision needs a hash the
attacker cannot obtain. Fixed anyway because of the *shape* of the failure — two
matching rows would resolve a token to whichever device Postgres returned
first, writing one patient's vital signs into another patient's chart with no
error and nothing on either dashboard looking wrong. That should be impossible
by construction, not improbable by arithmetic.

---

## Not covered

Stated so nobody reads this document as broader than it is.

- **No penetration test.** No attempt was made to exploit anything from
  outside.
- **No dependency CVE scan** beyond `npm audit` defaults. No SBOM.
- **No formal compliance mapping.** HIPAA and GDPR obligations — breach
  notification, retention schedules, data processing agreements, the right to
  erasure — are not implemented and not assessed. AVERIS has an audit trail and
  an access model; that is a foundation, not compliance.
- **No key rotation procedure.** Device tokens can be rotated per device; the
  Supabase service-role key has no documented rotation path.
- **Transport between the ingest service and Supabase** is whatever the
  deployment configures. Nothing enforces TLS on that hop in code.
- **BLE is unauthenticated by design** and read-only. Anyone in range can read
  the advertised vitals of a band they are standing next to. Documented in
  `docs/hardware.md`; pairing and bonding are not implemented.

---

## Recommended next, in order

1. **Nonce-based CSP** via `proxy.ts`, removing `'unsafe-inline'` from
   `script-src`. This is the largest remaining web-layer gap.
2. **TLS enforcement on the ingest hop**, and a documented rotation procedure
   for the service-role key.
3. **A dependency scan in CI** — `npm audit --audit-level=high` and `pip-audit`,
   failing the build rather than reporting.
4. **BLE pairing** if the local read path is ever exposed beyond a bench.
