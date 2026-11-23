-- 0003_cache_tokens.sql
--
-- novaflow-v02/spend.md (run costing, item zero): task_runs records the two
-- cache components of the prompt side separately, so fresh input is never
-- conflated with cache reads/writes and cost_usd can price them.
--
-- The statements below are pinned VERBATIM in the novaflow-v1/data DDL block
-- (the golden one-source rule: test/golden/ddl.test.ts compares text). Do not
-- reformat them. DEFAULT 0 keeps every row written by earlier code valid; such
-- rows are reported as cost_basis "legacy" and are never rewritten.

ALTER TABLE task_runs ADD COLUMN cache_read_tokens INTEGER NOT NULL DEFAULT 0;
ALTER TABLE task_runs ADD COLUMN cache_write_tokens INTEGER NOT NULL DEFAULT 0;
