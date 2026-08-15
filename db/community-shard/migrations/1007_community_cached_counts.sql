ALTER TABLE communities
    ADD COLUMN cached_member_count INTEGER;

ALTER TABLE communities
    ADD COLUMN cached_qualified_member_count INTEGER;
