ALTER TABLE moderation_actions
    ADD COLUMN previous_post_status TEXT CHECK (
        previous_post_status IN ('draft', 'published', 'hidden', 'removed', 'deleted')
    );

ALTER TABLE moderation_actions
    ADD COLUMN next_post_status TEXT CHECK (
        next_post_status IN ('draft', 'published', 'hidden', 'removed', 'deleted')
    );

ALTER TABLE moderation_actions
    ADD COLUMN previous_age_gate_policy TEXT CHECK (
        previous_age_gate_policy IN ('none', '18_plus')
    );

ALTER TABLE moderation_actions
    ADD COLUMN next_age_gate_policy TEXT CHECK (
        next_age_gate_policy IN ('none', '18_plus')
    );
