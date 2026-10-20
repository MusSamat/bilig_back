-- Contract 0.8.0: roles (manager + StaffProfile), support sessions, the action
-- journal (AuditEvent: append-only, hash-chained, partitioned by month),
-- deletion requests, teacher profile (teachingLang), classes with several
-- subjects. See docs/CONTRACT_CHANGES-0.8.0.md.

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------
ALTER TABLE "User" ADD COLUMN "teachingLang" TEXT;
ALTER TABLE "User" ADD COLUMN "lastLoginAt" TIMESTAMPTZ(3);

ALTER TABLE "Invite" ADD COLUMN "permissions" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "Class" ADD COLUMN "subjectKeys" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
UPDATE "Class" SET "subjectKeys" = ARRAY["subjectKey"] WHERE "subjectKey" IS NOT NULL;

-- ---------------------------------------------------------------------------
-- Staff
-- ---------------------------------------------------------------------------
CREATE TABLE "StaffProfile" (
    "userId" UUID NOT NULL,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "scope" JSONB,
    "createdBy" UUID,
    "createdAt" TIMESTAMPTZ(3) NOT NULL,
    "blockedAt" TIMESTAMPTZ(3),
    "deletedAt" TIMESTAMPTZ(3),
    CONSTRAINT "StaffProfile_pkey" PRIMARY KEY ("userId")
);

-- Existing author / editor grants become manager with the matching content
-- permissions (author → content.draft.edit, model.upload; editor → also
-- content.publish, content.review): no one loses access.
INSERT INTO "StaffProfile" ("userId", "permissions", "createdBy", "createdAt")
SELECT "userId",
       CASE WHEN bool_or("role" = 'editor')
            THEN ARRAY['content.draft.edit', 'model.upload', 'content.publish', 'content.review']
            ELSE ARRAY['content.draft.edit', 'model.upload'] END,
       NULL, now()
FROM "RoleAssignment" WHERE "role" IN ('author', 'editor')
GROUP BY "userId"
ON CONFLICT ("userId") DO NOTHING;

INSERT INTO "RoleAssignment" ("id", "userId", "role", "scopeType", "scopeId", "subrole")
SELECT gen_random_uuid(), "userId", 'manager', 'platform', '', NULL
FROM "RoleAssignment" WHERE "role" IN ('author', 'editor')
GROUP BY "userId"
ON CONFLICT ("userId", "role", "scopeType", "scopeId") DO NOTHING;

DELETE FROM "RoleAssignment" WHERE "role" IN ('author', 'editor');

-- SuperAdmins get a profile too (lifecycle: block / restore / delete).
INSERT INTO "StaffProfile" ("userId", "permissions", "createdBy", "createdAt")
SELECT DISTINCT "userId", ARRAY[]::TEXT[], NULL::UUID, now() FROM "RoleAssignment" WHERE "role" = 'superadmin'
ON CONFLICT ("userId") DO NOTHING;

-- Pending author / editor invites become manager invites with the same mapping.
UPDATE "Invite"
SET "permissions" = CASE WHEN "role" = 'editor'
                         THEN ARRAY['content.draft.edit', 'model.upload', 'content.publish', 'content.review']
                         ELSE ARRAY['content.draft.edit', 'model.upload'] END,
    "role" = 'manager', "scopeType" = 'platform', "scopeId" = NULL, "subrole" = NULL
WHERE "role" IN ('author', 'editor') AND "acceptedAt" IS NULL;

-- ---------------------------------------------------------------------------
-- Support sessions
-- ---------------------------------------------------------------------------
CREATE TABLE "ImpersonationSession" (
    "id" UUID NOT NULL,
    "actorId" UUID NOT NULL,
    "teacherId" UUID NOT NULL,
    "mode" TEXT NOT NULL,
    "reason" TEXT,
    "ip" TEXT,
    "startedAt" TIMESTAMPTZ(3) NOT NULL,
    "expiresAt" TIMESTAMPTZ(3) NOT NULL,
    "endedAt" TIMESTAMPTZ(3),
    "endedBy" UUID,
    "endReason" TEXT,
    CONSTRAINT "ImpersonationSession_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "ImpersonationSession_actorId_idx" ON "ImpersonationSession"("actorId");
CREATE INDEX "ImpersonationSession_teacherId_idx" ON "ImpersonationSession"("teacherId");
CREATE INDEX "ImpersonationSession_endedAt_expiresAt_idx" ON "ImpersonationSession"("endedAt", "expiresAt");

-- ---------------------------------------------------------------------------
-- Deletion requests and journal alerts
-- ---------------------------------------------------------------------------
CREATE TABLE "DeletionRequest" (
    "id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "targetLabel" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "requestedBy" UUID NOT NULL,
    "requestedAt" TIMESTAMPTZ(3) NOT NULL,
    "decidedBy" UUID,
    "decidedAt" TIMESTAMPTZ(3),
    "decisionNote" TEXT,
    CONSTRAINT "DeletionRequest_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DeletionRequest_status_idx" ON "DeletionRequest"("status");
CREATE INDEX "DeletionRequest_requestedBy_idx" ON "DeletionRequest"("requestedBy");

CREATE TABLE "AuditAlert" (
    "id" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "kind" TEXT NOT NULL,
    "actorId" UUID,
    "summary" TEXT NOT NULL,
    "seenAt" TIMESTAMPTZ(3),
    CONSTRAINT "AuditAlert_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "AuditAlert_key_key" ON "AuditAlert"("key");
CREATE INDEX "AuditAlert_at_idx" ON "AuditAlert"("at");

-- ---------------------------------------------------------------------------
-- The action journal
-- ---------------------------------------------------------------------------
CREATE TABLE "AuditEvent" (
    "seq" BIGINT NOT NULL,
    "id" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "actorId" UUID,
    "actorRole" TEXT,
    "onBehalfOfId" UUID,
    "group" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "targetType" TEXT NOT NULL,
    "targetId" TEXT NOT NULL,
    "targetLabel" TEXT,
    "before" JSONB,
    "after" JSONB,
    "details" JSONB,
    "reason" TEXT,
    "result" TEXT NOT NULL,
    "ip" TEXT,
    "userAgent" TEXT,
    "requestId" TEXT,
    "supportSessionId" UUID,
    "prevHash" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("seq", "at")
) PARTITION BY RANGE ("at");

CREATE INDEX "AuditEvent_id_idx" ON "AuditEvent"("id");
CREATE INDEX "AuditEvent_actorId_seq_idx" ON "AuditEvent"("actorId", "seq");
CREATE INDEX "AuditEvent_onBehalfOfId_idx" ON "AuditEvent"("onBehalfOfId");
CREATE INDEX "AuditEvent_action_idx" ON "AuditEvent"("action");
CREATE INDEX "AuditEvent_targetType_targetId_idx" ON "AuditEvent"("targetType", "targetId");

-- Rows outside every monthly partition (the job did not run) land here.
CREATE TABLE "AuditEvent_default" PARTITION OF "AuditEvent" DEFAULT;

-- Append-only: UPDATE and DELETE are rejected (the app's DB user owns the
-- table, so revoking privileges would not be enough). Dropping an old
-- partition (retention) is DDL and stays possible.
CREATE FUNCTION audit_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AuditEvent is append-only (% rejected)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER audit_event_immutable BEFORE UPDATE OR DELETE ON "AuditEvent"
  FOR EACH ROW EXECUTE FUNCTION audit_event_immutable();

-- The canonical JSON of a row: jsonb's normalised text of every field except
-- `hash` (the same value always yields the same text).
CREATE FUNCTION audit_event_canonical(e "AuditEvent") RETURNS text LANGUAGE sql STABLE AS $$
  SELECT jsonb_build_object(
    'seq', e."seq", 'id', e."id", 'at', to_char(e."at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'actorId', e."actorId", 'actorRole', e."actorRole", 'onBehalfOfId', e."onBehalfOfId",
    'group', e."group", 'action', e."action",
    'targetType', e."targetType", 'targetId', e."targetId", 'targetLabel', e."targetLabel",
    'before', e."before", 'after', e."after", 'details', e."details",
    'reason', e."reason", 'result', e."result",
    'ip', e."ip", 'userAgent', e."userAgent", 'requestId', e."requestId",
    'supportSessionId', e."supportSessionId", 'prevHash', e."prevHash"
  )::text
$$;

CREATE FUNCTION audit_event_hash(e "AuditEvent") RETURNS text LANGUAGE sql STABLE AS $$
  SELECT encode(sha256(convert_to(e."prevHash" || audit_event_canonical(e), 'UTF8')), 'hex')
$$;

-- Append one event: a transaction-level advisory lock serialises writers, so
-- the chain (seq, prevHash) is linear. Returns the stored row.
CREATE FUNCTION audit_event_append(p jsonb) RETURNS SETOF "AuditEvent" LANGUAGE plpgsql AS $$
DECLARE
  r "AuditEvent";
  last_seq BIGINT;
  last_hash TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(7461801080);
  SELECT "seq", "hash" INTO last_seq, last_hash FROM "AuditEvent" ORDER BY "seq" DESC LIMIT 1;
  r."seq" := COALESCE(last_seq, 0) + 1;
  r."prevHash" := COALESCE(last_hash, '');
  r."id" := (p->>'id')::uuid;
  r."at" := (p->>'at')::timestamptz;
  r."actorId" := NULLIF(p->>'actorId', '')::uuid;
  r."actorRole" := p->>'actorRole';
  r."onBehalfOfId" := NULLIF(p->>'onBehalfOfId', '')::uuid;
  r."group" := p->>'group';
  r."action" := p->>'action';
  r."targetType" := p->>'targetType';
  r."targetId" := p->>'targetId';
  r."targetLabel" := p->>'targetLabel';
  r."before" := CASE WHEN jsonb_typeof(p->'before') IN ('null') THEN NULL ELSE p->'before' END;
  r."after" := CASE WHEN jsonb_typeof(p->'after') IN ('null') THEN NULL ELSE p->'after' END;
  r."details" := CASE WHEN jsonb_typeof(p->'details') IN ('null') THEN NULL ELSE p->'details' END;
  r."reason" := p->>'reason';
  r."result" := COALESCE(p->>'result', 'ok');
  r."ip" := p->>'ip';
  r."userAgent" := p->>'userAgent';
  r."requestId" := p->>'requestId';
  r."supportSessionId" := NULLIF(p->>'supportSessionId', '')::uuid;
  r."hash" := audit_event_hash(r);
  INSERT INTO "AuditEvent" SELECT (r).*;
  RETURN NEXT r;
END $$;

-- Walk the chain: seq has no gaps, every prevHash is the previous hash, every
-- hash matches its row. The first row after retention is the anchor.
CREATE FUNCTION audit_event_verify() RETURNS TABLE(ok boolean, checked bigint, broken_at bigint) LANGUAGE plpgsql AS $$
DECLARE
  r "AuditEvent";
  prev_hash TEXT := NULL;
  prev_seq BIGINT := NULL;
  n BIGINT := 0;
BEGIN
  FOR r IN SELECT * FROM "AuditEvent" ORDER BY "seq" LOOP
    n := n + 1;
    IF (prev_seq IS NOT NULL AND (r."seq" <> prev_seq + 1 OR r."prevHash" <> prev_hash))
       OR (prev_seq IS NULL AND r."seq" = 1 AND r."prevHash" <> '')
       OR r."hash" <> audit_event_hash(r) THEN
      RETURN QUERY SELECT false, n, r."seq";
      RETURN;
    END IF;
    prev_hash := r."hash";
    prev_seq := r."seq";
  END LOOP;
  RETURN QUERY SELECT true, n, NULL::bigint;
END $$;

-- Partition job: monthly partitions `AuditEvent_pYYYYMM` for this month and
-- `ahead` more; partitions that ended `retain_months` before this month are
-- dropped (retention: DDL, not row deletion).
CREATE FUNCTION audit_event_maintain(p_now timestamptz, ahead int, retain_months int)
RETURNS TABLE(created int, dropped int) LANGUAGE plpgsql AS $$
DECLARE
  base timestamptz := date_trunc('month', p_now AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
  m timestamptz;
  name text;
  c int := 0;
  d int := 0;
  part record;
BEGIN
  FOR i IN 0..ahead LOOP
    m := base + make_interval(months => i);
    name := 'AuditEvent_p' || to_char(m AT TIME ZONE 'UTC', 'YYYYMM');
    IF to_regclass(format('%I', name)) IS NULL THEN
      BEGIN
        EXECUTE format('CREATE TABLE %I PARTITION OF "AuditEvent" FOR VALUES FROM (%L) TO (%L)', name, m, m + interval '1 month');
        c := c + 1;
      EXCEPTION WHEN others THEN
        -- rows for this month already sit in the DEFAULT partition: keep them there
        RAISE NOTICE 'audit_event_maintain: % not created: %', name, SQLERRM;
      END;
    END IF;
  END LOOP;
  FOR part IN
    SELECT cl.relname FROM pg_inherits i JOIN pg_class cl ON cl.oid = i.inhrelid
    WHERE i.inhparent = '"AuditEvent"'::regclass AND cl.relname ~ '^AuditEvent_p[0-9]{6}$'
  LOOP
    IF (to_date(substr(part.relname, 13), 'YYYYMM')::timestamp AT TIME ZONE 'UTC') + interval '1 month'
       <= base - make_interval(months => retain_months) THEN
      EXECUTE format('DROP TABLE %I', part.relname);
      d := d + 1;
    END IF;
  END LOOP;
  RETURN QUERY SELECT c, d;
END $$;

-- Partitions for every month of the existing audit history, plus three ahead.
DO $$
DECLARE
  first_month timestamptz;
  m timestamptz;
  name text;
BEGIN
  SELECT date_trunc('month', min("ts") AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' INTO first_month FROM "AuditLog";
  IF first_month IS NOT NULL THEN
    m := first_month;
    WHILE m < date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC' LOOP
      name := 'AuditEvent_p' || to_char(m AT TIME ZONE 'UTC', 'YYYYMM');
      EXECUTE format('CREATE TABLE %I PARTITION OF "AuditEvent" FOR VALUES FROM (%L) TO (%L)', name, m, m + interval '1 month');
      m := m + interval '1 month';
    END LOOP;
  END IF;
END $$;
SELECT * FROM audit_event_maintain(now(), 3, 36);

-- Copy the legacy AuditLog into the journal, in time order, chained.
DO $$
DECLARE
  a record;
BEGIN
  FOR a IN SELECT * FROM "AuditLog" ORDER BY "ts", "id" LOOP
    PERFORM audit_event_append(jsonb_build_object(
      'id', a."id",
      'at', to_char(a."ts" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'actorId', a."actorId",
      'group', CASE
        WHEN a."action" LIKE 'auth.%' THEN 'auth'
        WHEN a."action" LIKE 'user.%' OR a."action" LIKE 'invite.%' OR a."action" LIKE 'staff.%' THEN 'staff'
        WHEN a."action" LIKE 'support.%' THEN 'support'
        WHEN a."action" LIKE 'content.%' OR a."action" LIKE 'asset.%' OR a."action" LIKE 'review.%'
          OR a."action" LIKE 'generated.%' OR a."action" LIKE 'tutor.%' THEN 'content'
        WHEN a."action" LIKE 'export.%' THEN 'export'
        WHEN a."action" LIKE 'deletion.%' THEN 'deletion'
        ELSE 'teacher_data' END,
      'action', a."action",
      'targetType', a."targetType",
      'targetId', a."targetId",
      'before', CASE WHEN jsonb_typeof(a."diff") = 'object' AND a."diff" ? 'before' THEN a."diff"->'before' END,
      'after', CASE WHEN jsonb_typeof(a."diff") = 'object' AND a."diff" ? 'after' THEN a."diff"->'after' END,
      'details', a."diff",
      'result', CASE WHEN a."action" = 'auth.login_failed' THEN 'failed' ELSE 'ok' END,
      'ip', a."ip"
    ));
  END LOOP;
END $$;

-- The legacy table is read only from now on.
CREATE FUNCTION audit_log_read_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'AuditLog is read only since contract 0.8.0 (% rejected); write to AuditEvent', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER audit_log_read_only BEFORE INSERT OR UPDATE OR DELETE ON "AuditLog"
  FOR EACH ROW EXECUTE FUNCTION audit_log_read_only();
