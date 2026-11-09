-- Prevent hard deletion of a provider budget reservation while it is still RESERVED.
-- Its amount is counted in ProviderDailyBudget."reservedCentiNeurons"; deleting the row
-- (directly, or via ON DELETE CASCADE from GenerationJob/User) would orphan that amount.
-- Settle the reservation first (CONSUMED or RELEASED); settled rows may be deleted.
-- Additive only: creates one function and one trigger. No tables, columns or rows change.

CREATE OR REPLACE FUNCTION "prevent_unsettled_reservation_delete"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'RESERVED' THEN
    RAISE EXCEPTION 'Cannot delete budget reservation % for job % while it is RESERVED; settle it first',
      OLD."id", OLD."jobId"
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN OLD;
END;
$$;

CREATE TRIGGER "ProviderBudgetReservation_block_unsettled_delete"
  BEFORE DELETE ON "ProviderBudgetReservation"
  FOR EACH ROW EXECUTE FUNCTION "prevent_unsettled_reservation_delete"();
