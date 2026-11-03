BEGIN;
CREATE OR REPLACE FUNCTION private.file_name_valid(name text,media text) RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT name IS NOT NULL AND name=btrim(name) AND normalize(name,NFKC)=name AND length(name) BETWEEN 3 AND 120 AND name !~ '[[:cntrl:]/:%]' AND name !~ '[<>"|?*]' AND name !~ U&'[\007F-\009F]' AND right(split_part(name,'.',1),1)<>' ' AND strpos(name,chr(92))=0 AND name !~ U&'[\202A-\202E\2066-\2069]' AND length(name)-length(replace(name,'.',''))=1 AND split_part(name,'.',1) !~* '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9]|CLOCK[$])$' AND
 (CASE lower(split_part(name,'.',2)) WHEN 'pdf' THEN media='application/pdf' WHEN 'png' THEN media='image/png' WHEN 'jpg' THEN media='image/jpeg' WHEN 'jpeg' THEN media='image/jpeg' WHEN 'webp' THEN media='image/webp' ELSE false END)
$$;

CREATE FUNCTION private.invalidate_pending_files() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE target uuid;
BEGIN
 IF NEW.work_policy_id IS DISTINCT FROM OLD.work_policy_id OR NEW.upload_validation_key_hash IS DISTINCT FROM OLD.upload_validation_key_hash THEN
  FOR target IN UPDATE public.file_objects SET state='REJECTED',validated_at=private.security_now(),validation_outcome='POLICY_OR_VALIDATION_KEY_CHANGED' WHERE state='QUARANTINED' RETURNING id LOOP
   PERFORM private.work_audit('file.policy_invalidated',jsonb_build_object('file_id',target));
  END LOOP;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER invalidate_pending_files AFTER UPDATE OF work_policy_id,upload_validation_key_hash ON company_settings FOR EACH ROW EXECUTE FUNCTION private.invalidate_pending_files();
REVOKE ALL ON FUNCTION private.invalidate_pending_files() FROM PUBLIC;
COMMIT;
