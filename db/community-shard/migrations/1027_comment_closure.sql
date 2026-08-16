CREATE TABLE comment_closure (
    ancestor_comment_id TEXT NOT NULL,
    descendant_comment_id TEXT NOT NULL,
    distance INTEGER NOT NULL,
    PRIMARY KEY (ancestor_comment_id, descendant_comment_id),
    FOREIGN KEY (ancestor_comment_id) REFERENCES comments(comment_id),
    FOREIGN KEY (descendant_comment_id) REFERENCES comments(comment_id)
);

CREATE INDEX idx_comment_closure_ancestor_distance
    ON comment_closure(ancestor_comment_id, distance, descendant_comment_id);

CREATE INDEX idx_comment_closure_descendant
    ON comment_closure(descendant_comment_id, ancestor_comment_id);
