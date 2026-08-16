CREATE UNIQUE INDEX idx_community_handle_label_reservations_active_payment_user
    ON community_handle_label_reservations(user_id)
    WHERE status = 'active' AND purpose = 'payment';
