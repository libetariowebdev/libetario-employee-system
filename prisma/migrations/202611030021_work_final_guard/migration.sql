BEGIN;
-- A slow lock wait must not turn a previously valid guard into a stale write permit.
-- session_user is the connection principal even inside SECURITY DEFINER functions.
CREATE FUNCTION private.work_final_guard() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor uuid;
BEGIN
 IF session_user='libetario_runtime' THEN
  actor=private.work_actor();
  IF actor IS NULL THEN RAISE EXCEPTION 'Work access required' USING ERRCODE='42501';END IF;
  IF TG_TABLE_NAME='projects' AND NOT private.is_admin() THEN RAISE EXCEPTION 'Administrator required' USING ERRCODE='42501';END IF;
  IF TG_TABLE_NAME='task_assignments' THEN
   IF NOT private.is_admin() AND NEW.employee_id<>actor THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
  END IF;
  IF TG_TABLE_NAME='task_comments' THEN
   IF NEW.author_id<>actor OR NOT private.can_task(NEW.task_id) THEN RAISE EXCEPTION 'Not found' USING ERRCODE='P0002';END IF;
  END IF;
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER project_final_guard BEFORE INSERT OR UPDATE ON projects FOR EACH ROW EXECUTE FUNCTION private.work_final_guard();
CREATE TRIGGER task_final_guard BEFORE INSERT OR UPDATE ON tasks FOR EACH ROW EXECUTE FUNCTION private.work_final_guard();
CREATE TRIGGER assignment_final_guard BEFORE INSERT OR UPDATE ON task_assignments FOR EACH ROW EXECUTE FUNCTION private.work_final_guard();
CREATE TRIGGER comment_final_guard BEFORE INSERT ON task_comments FOR EACH ROW EXECUTE FUNCTION private.work_final_guard();
REVOKE ALL ON FUNCTION private.work_final_guard() FROM PUBLIC;
COMMIT;
