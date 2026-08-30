-- Fix v_stage_age: stage_history.at is `timestamp without time zone` holding UTC
-- (01 — "All timestamps UTC"). The original view cast it with `::timestamptz`,
-- which makes Postgres interpret the value in the SESSION timezone instead of
-- UTC. On any server not set to UTC every age was shifted by the offset, and
-- rows newer than the offset came out NEGATIVE (a card that just moved showed
-- "-1d" on the pipeline board).
--
-- `at AT TIME ZONE 'UTC'` is the correct conversion: it reads the naive
-- timestamp AS UTC and yields a timestamptz. Result is now session-independent.
CREATE OR REPLACE VIEW v_stage_age AS
SELECT
  s.id                                                              AS system_id,
  s.stage,
  h.at                                                              AS entered_stage_at,
  now() - (h.at AT TIME ZONE 'UTC')                                 AS age_interval,
  EXTRACT(epoch FROM now() - (h.at AT TIME ZONE 'UTC')) / 86400.0   AS days_in_stage
FROM systems s
LEFT JOIN LATERAL (
  SELECT sh.at
  FROM stage_history sh
  WHERE sh.system_id = s.id AND sh.to_stage = s.stage
  ORDER BY sh.at DESC
  LIMIT 1
) h ON true;
