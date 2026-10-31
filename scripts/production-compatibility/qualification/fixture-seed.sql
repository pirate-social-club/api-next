-- Disposable partial history only. The qualification driver uses a local
-- superuser transaction with session_replication_role=replica for this setup.
-- Existing CHECKs, NOT NULL and unique constraints remain enforced. Upstream
-- winner-credit authorization is deliberately absent, so this is not a valid
-- economic journey, issuance, attestation or participant acceptance.
INSERT INTO users(user_id) VALUES ('fixture_account'),('fixture_other_account');
INSERT INTO personas(persona_id,account_id) VALUES ('fixture_persona','fixture_account');
INSERT INTO communities(community_id,display_name,created_by_user_id,created_at,updated_at,status)
VALUES ('fixture_community','Synthetic compatibility fixture','fixture_account','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','archived');
INSERT INTO persona_wallet_assignments(assignment_id,persona_id,account_id,chain_account_kind,hd_wallet_index,address,status,reservation_idempotency_key,assigned_at,created_at,updated_at)
VALUES ('fixture_wallet','fixture_persona','fixture_account','evm',0,'0x1111111111111111111111111111111111111111','active','fixture_wallet_reservation','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z');
-- A closed synthetic first send preserves the one-open-send-per-sender index.
-- These partial states attest no chain outcome.
INSERT INTO reward_winner_sends(send_id,credit_id,account_id,persona_id,wallet_assignment_id,chain_id,token_address,sender_address,attempt,status,created_at,updated_at)
SELECT id,'fixture_unmodelled_credit_'||id,'fixture_account','fixture_persona','fixture_wallet',84532,
 '0x2222222222222222222222222222222222222222','0x1111111111111111111111111111111111111111',1,
 CASE WHEN id='fixture_send_a' THEN 'cancelled' ELSE 'pending' END,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z'
FROM (VALUES ('fixture_send_a'),('fixture_send_b')) AS sends(id);
INSERT INTO reward_winner_send_attempts(send_id,attempt,account_id,idempotency_key,recipient_address,amount_atomic,nonce,created_at)
VALUES ('fixture_send_a',1,'fixture_account','fixture_attempt_a','0x3333333333333333333333333333333333333333',1,11,'2026-01-01T00:00:00Z'),
 ('fixture_send_b',1,'fixture_account','fixture_attempt_b','0x3333333333333333333333333333333333333333',1,12,'2026-01-01T00:00:00Z');
INSERT INTO posts(community_id,post_id,author_user_id,author_persona_id,post_type,status,title,created_at,updated_at,author_declared_rating,content_rating)
SELECT 'fixture_community',id,'fixture_account','fixture_persona',kind,status,'Synthetic compatibility history','2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','general','general'
FROM (VALUES ('fixture_song_a','song','published'),('fixture_song_b','song','published'),
 ('fixture_song_draft','song','draft'),('fixture_video','video','published')) AS items(id,kind,status);
