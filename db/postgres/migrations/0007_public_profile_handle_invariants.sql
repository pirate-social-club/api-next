-- Public handle lifecycle invariants. The partial unique index is deliberately
-- forward-only: existing duplicate active owners must be reconciled before this
-- migration is applied. Redirect foreign keys are deferred so a rename can
-- retarget history before inserting the replacement active row in one transaction.

ALTER TABLE public_handle_index
  DROP CONSTRAINT public_handle_index_redirect_fk;

ALTER TABLE public_handle_index
  ADD CONSTRAINT public_handle_index_redirect_fk
    FOREIGN KEY (redirect_target_handle_id) REFERENCES public_handle_index (handle_id)
    DEFERRABLE INITIALLY DEFERRED;

CREATE UNIQUE INDEX public_handle_index_one_active_owner_uidx
  ON public_handle_index (owner_user_id)
  WHERE status = 'active';

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public_handle_index AS source
      LEFT JOIN public_handle_index AS target
        ON target.handle_id = source.redirect_target_handle_id
     WHERE source.status = 'redirect'
       AND (
         target.handle_id IS NULL
         OR target.status <> 'active'
         OR target.owner_user_id <> source.owner_user_id
         OR target.handle_id = source.handle_id
       )
  ) THEN
    RAISE EXCEPTION 'existing public handle redirect is not a direct active same-owner target';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public_handle_index_validate_redirects()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.status = 'redirect' AND NOT EXISTS (
    SELECT 1
      FROM public_handle_index AS target
     WHERE target.handle_id = NEW.redirect_target_handle_id
       AND target.status = 'active'
       AND target.owner_user_id = NEW.owner_user_id
       AND target.handle_id <> NEW.handle_id
  ) THEN
    RAISE EXCEPTION 'public handle redirect target is not an active handle owned by the same user'
      USING ERRCODE = '23514', CONSTRAINT = 'public_handle_index_redirect_integrity';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public_handle_index AS source
     WHERE source.status = 'redirect'
       AND source.redirect_target_handle_id = NEW.handle_id
       AND NOT EXISTS (
         SELECT 1
           FROM public_handle_index AS target
          WHERE target.handle_id = source.redirect_target_handle_id
            AND target.status = 'active'
            AND target.owner_user_id = source.owner_user_id
            AND target.handle_id <> source.handle_id
       )
  ) THEN
    RAISE EXCEPTION 'public handle redirect source points at an invalid target'
      USING ERRCODE = '23514', CONSTRAINT = 'public_handle_index_redirect_integrity';
  END IF;

  RETURN NEW;
END;
$$;

CREATE CONSTRAINT TRIGGER public_handle_index_redirect_integrity
AFTER INSERT OR UPDATE OF status, owner_user_id, redirect_target_handle_id
ON public_handle_index
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION public_handle_index_validate_redirects();
