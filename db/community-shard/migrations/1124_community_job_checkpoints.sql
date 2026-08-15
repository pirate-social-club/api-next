ALTER TABLE community_jobs ADD COLUMN last_checkpoint TEXT;
ALTER TABLE community_jobs ADD COLUMN last_checkpoint_at TEXT;
ALTER TABLE community_jobs ADD COLUMN attempt_started_at TEXT;
ALTER TABLE community_jobs ADD COLUMN attempt_deadline_at TEXT;

CREATE INDEX IF NOT EXISTS idx_community_jobs_running_deadline
  ON community_jobs(status, attempt_deadline_at)
  WHERE status = 'running';

CREATE INDEX IF NOT EXISTS idx_community_jobs_running_checkpoint
  ON community_jobs(status, last_checkpoint_at)
  WHERE status = 'running';

CREATE TABLE IF NOT EXISTS community_job_events (
  event_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  community_id TEXT NOT NULL,
  checkpoint TEXT NOT NULL,
  details_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES community_jobs(job_id),
  FOREIGN KEY (community_id) REFERENCES communities(community_id)
);

CREATE INDEX IF NOT EXISTS idx_community_job_events_job
  ON community_job_events(job_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_community_job_events_community
  ON community_job_events(community_id, created_at DESC);
