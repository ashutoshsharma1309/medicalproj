-- ===========================================================================
-- AVERIS IoT — Phase 5b: one token hash, one device
--
-- Found by running the device-authentication assertions against a real
-- database for the first time: `private.resolve_device` is declared
-- `returns table` and had nothing guaranteeing it returned a single row.
--
-- ── Is this exploitable today? No. It is still wrong. ──────────────────────
--
-- A device token is 256 bits of CSPRNG output, so two devices colliding by
-- accident will not happen. A patient cannot deliberately collide with someone
-- else's device either, because doing so requires knowing that device's hash
-- and the column is not readable by any client role.
--
-- What makes it worth fixing anyway is the shape of the failure if it ever did
-- occur. `store.py` reads `rows[0]`. With two matching rows, the ingest service
-- would resolve a token to whichever device Postgres returned first — writing
-- one patient's vital signs into another patient's chart, with no error
-- anywhere and nothing on either dashboard looking wrong. That is the worst
-- failure mode this system has, and it should be impossible by construction
-- rather than improbable by arithmetic.
--
-- The constraint also documents an assumption the ingest path already makes.
-- Code that reads `rows[0]` is asserting uniqueness; better to assert it where
-- the database can enforce it.
-- ===========================================================================

-- Will fail loudly if duplicates already exist, which is the correct
-- behaviour: two devices sharing a credential is not a state to migrate
-- quietly past.
alter table public.iot_devices
  add constraint iot_devices_token_hash_unique unique (token_hash);

comment on constraint iot_devices_token_hash_unique on public.iot_devices is
  'One token hash, one device. resolve_device() reads rows[0]; this is what makes that safe.';
