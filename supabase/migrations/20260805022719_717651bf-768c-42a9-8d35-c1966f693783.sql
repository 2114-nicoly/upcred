DROP FUNCTION IF EXISTS public.close_daily_cash_with_snapshot(date, numeric, text, jsonb);

REVOKE ALL ON FUNCTION public.close_daily_cash_with_snapshot(date, numeric, text) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.close_daily_cash_with_snapshot(date, numeric, text) TO authenticated, service_role;

NOTIFY pgrst, 'reload schema';