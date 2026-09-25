-- Public trending reads the last seven days of session starts across every
-- activity table. Without an index leading on created_at, each anonymous
-- trending request scanned all session history.
CREATE INDEX study_sessions_created_at ON study_sessions(created_at);
CREATE INDEX study_sessions_v2_created_at ON study_sessions_v2(created_at);
CREATE INDEX karaoke_sessions_created_at ON karaoke_sessions(created_at);
CREATE INDEX dance_sessions_created_at ON dance_sessions(created_at);
