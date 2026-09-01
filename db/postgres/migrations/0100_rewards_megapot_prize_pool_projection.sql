ALTER TABLE megapot_drawing_observations
  ADD COLUMN gross_prize_pool_atomic NUMERIC(78, 0),
  ADD COLUMN global_tickets_bought NUMERIC(78, 0),
  ADD CONSTRAINT megapot_drawing_observations_prize_pool_pair CHECK (
    (
      gross_prize_pool_atomic IS NULL
      AND global_tickets_bought IS NULL
    )
    OR (
      gross_prize_pool_atomic IS NOT NULL
      AND global_tickets_bought IS NOT NULL
      AND gross_prize_pool_atomic >= 0
      AND global_tickets_bought >= 0
    )
  );
