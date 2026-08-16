ALTER TABLE live_room_replay_assets ADD COLUMN locked_delivery_secret_json TEXT;
ALTER TABLE live_room_replay_assets ADD COLUMN story_namespace TEXT;
ALTER TABLE live_room_replay_assets ADD COLUMN story_entitlement_token_id TEXT;
ALTER TABLE live_room_replay_assets ADD COLUMN story_read_condition TEXT;
ALTER TABLE live_room_replay_assets ADD COLUMN story_write_condition TEXT;
ALTER TABLE live_room_replay_assets ADD COLUMN locked_delivery_error TEXT;
