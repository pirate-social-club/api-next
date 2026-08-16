ALTER TABLE assets
ADD COLUMN story_royalty_policy_id TEXT;

ALTER TABLE assets
ADD COLUMN story_derivative_parent_ip_ids_json TEXT;

ALTER TABLE assets
ADD COLUMN story_royalty_registration_status TEXT NOT NULL DEFAULT 'none' CHECK (
    story_royalty_registration_status IN ('none', 'pending', 'registered', 'failed')
);
