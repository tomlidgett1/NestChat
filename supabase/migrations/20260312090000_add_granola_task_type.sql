-- Add 'granola' to the allowed task_type values in ingestion_tasks
ALTER TABLE public.ingestion_tasks
  DROP CONSTRAINT IF EXISTS ingestion_tasks_task_type_check;

ALTER TABLE public.ingestion_tasks
  ADD CONSTRAINT ingestion_tasks_task_type_check
  CHECK (task_type IN ('emails', 'calendar', 'transcript', 'granola'));
