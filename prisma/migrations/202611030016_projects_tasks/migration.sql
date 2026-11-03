BEGIN;
-- Checkpoint 3a only. No submission, file, notification or time-accounting tables.
CREATE FUNCTION private.work_url(value text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT value IS NULL OR (length(value) BETWEEN 1 AND 2048 AND value ~ '^https?://[^/?#[:space:]]+' AND value !~ '[[:cntrl:]\\[:space:]]' AND split_part(split_part(split_part(value,'://',2),'/',1),'?',1) !~ '@')
$$;
CREATE FUNCTION private.work_links(value jsonb) RETURNS boolean LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE item jsonb;
BEGIN
 IF value IS NULL OR jsonb_typeof(value)<>'array' THEN RETURN false;END IF;
 IF jsonb_array_length(value)>10 THEN RETURN false;END IF;
 FOR item IN SELECT * FROM jsonb_array_elements(value) LOOP
  IF jsonb_typeof(item)<>'object' OR jsonb_typeof(item->'url')<>'string' OR item->>'url' IS NULL OR NOT private.work_url(item->>'url') OR
   (item ? 'label' AND (jsonb_typeof(item->'label')<>'string' OR length(item->>'label')>120)) OR (item-'url'-'label')<>'{}'::jsonb THEN RETURN false;END IF;
 END LOOP;RETURN true;
END $$;
CREATE TABLE projects (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),code text NOT NULL UNIQUE CHECK(code ~ '^[A-Z0-9][A-Z0-9_-]{1,39}$'),name text NOT NULL CHECK(length(btrim(name)) BETWEEN 1 AND 200),
 client_label text CHECK(length(client_label)<=200),website_url text CHECK(private.work_url(website_url)),description text NOT NULL DEFAULT '' CHECK(length(description)<=10000),
 reference_links jsonb NOT NULL DEFAULT '[]' CHECK(private.work_links(reference_links)),start_date date,deadline_at timestamptz,
 priority text NOT NULL DEFAULT 'NORMAL' CHECK(priority IN ('LOW','NORMAL','HIGH','URGENT')),
 status text NOT NULL DEFAULT 'ACTIVE' CHECK(status IN ('PLANNING','ACTIVE','ON_HOLD','COMPLETED','CANCELLED')),
 created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,status_changed_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,status_changed_at timestamptz NOT NULL DEFAULT private.security_now(),
 created_at timestamptz NOT NULL DEFAULT private.security_now(),updated_at timestamptz NOT NULL DEFAULT private.security_now(),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 creation_key uuid NOT NULL,creation_fingerprint text NOT NULL CHECK(creation_fingerprint ~ '^[a-f0-9]{64}$'),UNIQUE(created_by,creation_key),
 CHECK(start_date IS NULL OR start_date BETWEEN '2000-01-01' AND '2099-12-31'),CHECK(deadline_at IS NULL OR start_date IS NULL OR (deadline_at AT TIME ZONE 'Asia/Manila')::date>=start_date)
);
CREATE INDEX ON projects(created_by);CREATE INDEX ON projects(status_changed_by);CREATE INDEX ON projects(status,deadline_at);
CREATE TABLE tasks (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),task_number text NOT NULL UNIQUE,project_id uuid NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
 title text NOT NULL CHECK(length(btrim(title)) BETWEEN 1 AND 200),instructions text NOT NULL DEFAULT '' CHECK(length(instructions)<=10000),reference_links jsonb NOT NULL DEFAULT '[]' CHECK(private.work_links(reference_links)),
 due_at timestamptz,priority text NOT NULL DEFAULT 'NORMAL' CHECK(priority IN ('LOW','NORMAL','HIGH','URGENT')),
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','IN_PROGRESS','SUBMITTED','REVISION_REQUIRED','APPROVED','CANCELLED')),
 CONSTRAINT task_3a_review_gate CHECK(status IN ('PENDING','IN_PROGRESS','CANCELLED')),
 assignment_mode text NOT NULL CHECK(assignment_mode IN ('INDIVIDUAL','SELECTED','ALL_ACTIVE')),collaboration_mode text NOT NULL DEFAULT 'SHARED' CHECK(collaboration_mode='SHARED'),
 created_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,status_changed_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,status_changed_at timestamptz NOT NULL DEFAULT private.security_now(),
 recipient_snapshot_at timestamptz NOT NULL DEFAULT private.security_now(),membership_version integer NOT NULL DEFAULT 1 CHECK(membership_version>0),
 created_at timestamptz NOT NULL DEFAULT private.security_now(),updated_at timestamptz NOT NULL DEFAULT private.security_now(),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 creation_key uuid NOT NULL,creation_fingerprint text NOT NULL CHECK(creation_fingerprint ~ '^[a-f0-9]{64}$'),UNIQUE(created_by,creation_key)
);
CREATE INDEX ON tasks(project_id,status,due_at);CREATE INDEX ON tasks(created_by);CREATE INDEX ON tasks(status_changed_by);
CREATE TABLE task_assignments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,employee_id uuid NOT NULL REFERENCES employee_profiles(user_id) ON DELETE RESTRICT,
 assigned_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,assigned_at timestamptz NOT NULL DEFAULT private.security_now(),assignment_origin text NOT NULL CHECK(assignment_origin IN ('INITIAL','ADMIN_ADDED')),
 status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','IN_PROGRESS','SUBMITTED','REVISION_REQUIRED','APPROVED','CANCELLED')),
 CONSTRAINT assignment_3a_review_gate CHECK(status IN ('PENDING','IN_PROGRESS','CANCELLED')),
 status_changed_by uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,status_changed_at timestamptz NOT NULL DEFAULT private.security_now(),counts_for_completion boolean NOT NULL DEFAULT true,
 access_revoked_at timestamptz,access_revoked_by uuid REFERENCES users(id) ON DELETE RESTRICT,revocation_reason text,
 created_at timestamptz NOT NULL DEFAULT private.security_now(),updated_at timestamptz NOT NULL DEFAULT private.security_now(),version integer NOT NULL DEFAULT 1 CHECK(version>0),
 last_list_seen_at timestamptz,seen_task_version integer NOT NULL DEFAULT 0 CHECK(seen_task_version>=0),seen_project_version integer NOT NULL DEFAULT 0 CHECK(seen_project_version>=0),seen_assignment_version integer NOT NULL DEFAULT 0 CHECK(seen_assignment_version>=0),
 UNIQUE(task_id,employee_id),UNIQUE(id,employee_id),UNIQUE(id,task_id),
 CHECK((access_revoked_at IS NULL AND access_revoked_by IS NULL AND revocation_reason IS NULL) OR (access_revoked_at IS NOT NULL AND access_revoked_by IS NOT NULL AND length(btrim(revocation_reason)) BETWEEN 10 AND 500)),
 CHECK(access_revoked_at IS NULL OR status='CANCELLED'),CHECK(counts_for_completion OR status='CANCELLED')
);
CREATE INDEX ON task_assignments(employee_id,access_revoked_at,task_id);CREATE INDEX ON task_assignments(assigned_by);CREATE INDEX ON task_assignments(status_changed_by);CREATE INDEX ON task_assignments(access_revoked_by);
CREATE TABLE task_comments (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE RESTRICT,author_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
 body text NOT NULL CHECK(length(btrim(body)) BETWEEN 1 AND 5000),created_at timestamptz NOT NULL DEFAULT private.security_now(),
 creation_key uuid NOT NULL,creation_fingerprint text NOT NULL CHECK(creation_fingerprint ~ '^[a-f0-9]{64}$'),UNIQUE(author_id,creation_key)
);
CREATE INDEX ON task_comments(task_id,created_at,id);
CREATE TRIGGER protect_task_comments BEFORE UPDATE OR DELETE OR TRUNCATE ON task_comments FOR EACH STATEMENT EXECUTE FUNCTION private.immutable();

-- Purpose-limited work identity; ordinary ACCOUNT/profile predicates stay unchanged.
CREATE FUNCTION private.work_actor() RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT CASE WHEN private.is_admin() THEN private.actor() ELSE (SELECT user_id FROM private.duty_context()) END
$$;
CREATE FUNCTION private.can_task(target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT private.is_admin() OR EXISTS(SELECT 1 FROM public.task_assignments a JOIN private.duty_context() d ON d.user_id=a.employee_id WHERE a.task_id=target AND a.access_revoked_at IS NULL)
$$;
CREATE FUNCTION private.can_project(target uuid) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT private.is_admin() OR EXISTS(SELECT 1 FROM public.tasks t JOIN public.task_assignments a ON a.task_id=t.id JOIN private.duty_context() d ON d.user_id=a.employee_id WHERE t.project_id=target AND a.access_revoked_at IS NULL)
$$;
ALTER TABLE projects ENABLE ROW LEVEL SECURITY;ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;ALTER TABLE task_assignments ENABLE ROW LEVEL SECURITY;ALTER TABLE task_comments ENABLE ROW LEVEL SECURITY;
CREATE POLICY project_work_read ON projects FOR SELECT TO libetario_runtime USING(private.can_project(id));
CREATE POLICY task_work_read ON tasks FOR SELECT TO libetario_runtime USING(private.can_task(id));
CREATE POLICY assignment_work_read ON task_assignments FOR SELECT TO libetario_runtime USING(private.is_admin() OR (employee_id=private.work_actor() AND access_revoked_at IS NULL AND private.can_task(task_id)));
CREATE POLICY comment_work_read ON task_comments FOR SELECT TO libetario_runtime USING(private.can_task(task_id));
REVOKE ALL ON projects,tasks,task_assignments,task_comments FROM PUBLIC,libetario_runtime,libetario_auth;
GRANT SELECT ON projects,tasks,task_assignments,task_comments TO libetario_runtime;
REVOKE ALL ON FUNCTION private.work_url(text),private.work_links(jsonb),private.work_actor(),private.can_task(uuid),private.can_project(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION private.work_actor(),private.can_task(uuid),private.can_project(uuid) TO libetario_runtime;

-- Database-level transition/shape checks also protect writes through a definer.
CREATE FUNCTION private.work_invariants() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF TG_TABLE_NAME='projects' THEN
  IF NEW.status='COMPLETED' THEN RAISE EXCEPTION 'Reviews required before completion' USING ERRCODE='22023';END IF;
  IF TG_OP='UPDATE' AND (NEW.id,NEW.created_by,NEW.creation_key,NEW.creation_fingerprint,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.created_by,OLD.creation_key,OLD.creation_fingerprint,OLD.created_at) THEN RAISE EXCEPTION 'Immutable identity' USING ERRCODE='22023';END IF;
 ELSIF TG_TABLE_NAME='tasks' THEN
  IF TG_OP='UPDATE' AND (NEW.id,NEW.project_id,NEW.assignment_mode,NEW.collaboration_mode,NEW.created_by,NEW.creation_key,NEW.creation_fingerprint,NEW.created_at,NEW.recipient_snapshot_at,NEW.task_number) IS DISTINCT FROM (OLD.id,OLD.project_id,OLD.assignment_mode,OLD.collaboration_mode,OLD.created_by,OLD.creation_key,OLD.creation_fingerprint,OLD.created_at,OLD.recipient_snapshot_at,OLD.task_number) THEN RAISE EXCEPTION 'Immutable task shape' USING ERRCODE='22023';END IF;
 ELSE
  IF TG_OP='INSERT' AND NEW.status<>'PENDING' THEN RAISE EXCEPTION 'Initial progress required' USING ERRCODE='22023';END IF;
  IF TG_OP='UPDATE' THEN
   IF (NEW.id,NEW.task_id,NEW.employee_id,NEW.assigned_by,NEW.assigned_at,NEW.assignment_origin,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.task_id,OLD.employee_id,OLD.assigned_by,OLD.assigned_at,OLD.assignment_origin,OLD.created_at) THEN RAISE EXCEPTION 'Immutable contribution identity' USING ERRCODE='22023';END IF;
   IF NEW.status<>OLD.status AND NOT ((OLD.status='PENDING' AND NEW.status='IN_PROGRESS') OR (OLD.status IN ('PENDING','IN_PROGRESS') AND NEW.status='CANCELLED') OR (OLD.status='CANCELLED' AND NEW.status='PENDING')) THEN RAISE EXCEPTION 'Invalid progress transition' USING ERRCODE='22023';END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER project_invariants BEFORE INSERT OR UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION private.work_invariants();
CREATE TRIGGER task_invariants BEFORE INSERT OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION private.work_invariants();
CREATE TRIGGER assignment_invariants BEFORE INSERT OR UPDATE ON task_assignments FOR EACH ROW EXECUTE FUNCTION private.work_invariants();
CREATE FUNCTION private.task_cardinality() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE target uuid;mode text;state text;n integer;
BEGIN
 target=CASE WHEN TG_TABLE_NAME='tasks' THEN NEW.id ELSE NEW.task_id END;
 SELECT assignment_mode,status INTO mode,state FROM public.tasks WHERE id=target;
 SELECT count(*) INTO n FROM public.task_assignments WHERE task_id=target AND access_revoked_at IS NULL;
 IF (mode='INDIVIDUAL' AND n>1) OR (state<>'CANCELLED' AND n=0) THEN RAISE EXCEPTION 'Invalid final assignment cardinality' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER task_cardinality AFTER INSERT OR UPDATE ON tasks DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.task_cardinality();
CREATE CONSTRAINT TRIGGER assignment_cardinality AFTER INSERT OR UPDATE ON task_assignments DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION private.task_cardinality();
REVOKE ALL ON FUNCTION private.work_invariants(),private.task_cardinality() FROM PUBLIC;
COMMIT;
