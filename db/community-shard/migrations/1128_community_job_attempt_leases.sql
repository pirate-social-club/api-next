ALTER TABLE community_jobs ADD COLUMN attempt_id TEXT;
ALTER TABLE community_jobs ADD COLUMN lease_expires_at TEXT;

CREATE INDEX IF NOT EXISTS idx_community_jobs_running_lease
  ON community_jobs(status, lease_expires_at)
  WHERE status = 'running';
