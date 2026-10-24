-- A pool leg's purchase order follows its custody. An owner-executed Safe can only
-- buy a drawing's ticket through a prepared call before entries open, and an EOA
-- custody only signs the commit-first order. Legs are created by the offer API and
-- by the shared-song producer, so the order is assigned here rather than by each
-- caller: a leg on Safe custody is ticket-first, and a ticket-first leg on any other
-- custody is refused.
CREATE FUNCTION assign_song_reward_leg_purchase_order() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind <> 'megapot_pool' THEN
    RETURN NEW;
  END IF;
  IF EXISTS (
    SELECT 1 FROM megapot_deployment_attestations attestation
      JOIN reward_signer_nonces signer
        ON signer.chain_id = attestation.chain_id
       AND signer.signer_address = attestation.custody_address
     WHERE attestation.attestation_id = NEW.attestation_id
       AND signer.nonce_authority = 'safe_owner_v1'
  ) THEN
    NEW.purchase_order := 'ticket_first_v1';
  ELSIF NEW.purchase_order <> 'commit_first' THEN
    RAISE EXCEPTION 'ticket-first pool legs require owner-executed Safe custody';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER song_reward_offer_legs_purchase_order_assign
BEFORE INSERT ON song_reward_offer_legs
FOR EACH ROW EXECUTE FUNCTION assign_song_reward_leg_purchase_order();
