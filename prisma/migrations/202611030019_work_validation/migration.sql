BEGIN;
CREATE OR REPLACE FUNCTION private.work_policy_check() RETURNS trigger LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
DECLARE cfg jsonb;
BEGIN
 IF NEW.policy_key='WORK' AND NEW.configuration ? 'tasks' THEN
  cfg=NEW.configuration->'tasks';
  IF jsonb_typeof(cfg) IS DISTINCT FROM 'object' OR jsonb_typeof(cfg->'maxRecipients') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'Invalid task policy' USING ERRCODE='22023';END IF;
  IF (cfg->>'maxRecipients')::numeric NOT BETWEEN 1 AND 500 OR trunc((cfg->>'maxRecipients')::numeric)<>(cfg->>'maxRecipients')::numeric OR (cfg-'maxRecipients')<>'{}'::jsonb THEN RAISE EXCEPTION 'Invalid task policy' USING ERRCODE='22023';END IF;
 END IF;RETURN NEW;
END $$;
-- Authority parsing is intentionally stricter than a browser URL normalizer.
CREATE OR REPLACE FUNCTION private.work_url(value text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT value IS NULL OR (length(value) BETWEEN 1 AND 2048 AND value ~ '^https?://[^/?#[:space:]]+' AND value !~ '[[:space:][:cntrl:]]' AND strpos(value,chr(92))=0 AND split_part(split_part(split_part(split_part(value,'://',2),'/',1),'?',1),'#',1) !~ '@')
$$;
COMMIT;
