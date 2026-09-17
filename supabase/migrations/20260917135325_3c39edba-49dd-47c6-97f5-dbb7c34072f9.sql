REVOKE ALL ON FUNCTION public._assert_open_cash_consistency(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cash_movements_assert_consistency() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cash_balance_guard_manual_changes() FROM PUBLIC, anon, authenticated;