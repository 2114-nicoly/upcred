import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";

const worker = "00000000-0000-0000-0000-000000000002";
const admin = "00000000-0000-0000-0000-000000000003";
const client = "00000000-0000-0000-0000-000000000004";
const old = "00000000-0000-0000-0000-000000000005";
const functions = readFileSync("src/test/fixtures/renewal-cash-functions.sql", "utf8");

async function setup(available = 2630, base = available) {
  const db = new PGlite();
  await db.exec(`
    CREATE SCHEMA auth;
    CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '${worker}'::uuid $$;
    CREATE TABLE clients(id uuid PRIMARY KEY, name text);
    CREATE TABLE loans(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), client_id uuid, worker_id uuid, admin_id uuid,
      status text, remaining_balance numeric, amount numeric, interest_type text, interest_value numeric,
      total_amount numeric, installment_count int, payment_type text, loan_date date, first_due_date date,
      renewed_from_loan_id uuid, observation text, user_id uuid, route_id uuid, is_imported_ongoing boolean DEFAULT false,
      initial_remaining_balance numeric, amount_already_paid numeric DEFAULT 0);
    CREATE TABLE installments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), loan_id uuid, number int, amount numeric,
      due_date date, status text, paid_amount numeric DEFAULT 0, paid_at timestamptz, is_penalty boolean DEFAULT false);
    CREATE TABLE penalties(loan_id uuid, amount numeric, paid_amount numeric, cancelled_at timestamptz, paid boolean);
    CREATE TABLE daily_cash(id uuid DEFAULT gen_random_uuid(), cash_date date, worker_id uuid, admin_id uuid, status text, opening_balance numeric);
    CREATE TABLE cash_balance(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), worker_id uuid, admin_id uuid,
      available_cash numeric, ledger_base_amount numeric, money_lent numeric DEFAULT 1000,
      interest_receivable numeric DEFAULT 200, penalty_receivable numeric DEFAULT 0, updated_at timestamptz);
    CREATE TABLE cash_movements(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), type text, amount numeric, client_id uuid,
      loan_id uuid, observation text, cash_date date, user_id uuid, worker_id uuid, admin_id uuid, daily_event_id uuid,
      reversed_at timestamptz, reversal_movement_id uuid, reverses_movement_id uuid);
    CREATE TABLE daily_events(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), cash_date date, event_type text, client_id uuid,
      loan_id uuid, amount_in numeric, amount_out numeric, observation text, origin text, cash_movement_id uuid,
      metadata jsonb, user_id uuid, worker_id uuid, admin_id uuid);
    CREATE TABLE audit_logs(action text);
    CREATE TABLE balance_writes(id uuid);
    CREATE FUNCTION _assert_loan_scope_caller(uuid,uuid) RETURNS void LANGUAGE plpgsql AS $$ BEGIN RETURN; END $$;
    CREATE FUNCTION log_audit(text,text,uuid,jsonb,jsonb,text,uuid) RETURNS void LANGUAGE sql AS $$ INSERT INTO audit_logs VALUES ($1) $$;
  `);
  await db.exec(functions);
  await db.exec(`
    CREATE TRIGGER derive BEFORE UPDATE ON cash_balance FOR EACH ROW EXECUTE FUNCTION cash_balance_derive_available();
    CREATE CONSTRAINT TRIGGER trg_cash_movements_sync_balance AFTER INSERT OR UPDATE OR DELETE ON cash_movements
      DEFERRABLE INITIALLY IMMEDIATE FOR EACH ROW EXECUTE FUNCTION cash_movements_sync_balance();
    CREATE FUNCTION count_write() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN INSERT INTO balance_writes VALUES(NEW.id); RETURN NEW; END $$;
    CREATE TRIGGER count_write AFTER UPDATE ON cash_balance FOR EACH ROW EXECUTE FUNCTION count_write();
    INSERT INTO clients VALUES('${client}', 'Ágata');
    INSERT INTO loans(id,client_id,worker_id,admin_id,status,remaining_balance,amount,total_amount,installment_count)
      VALUES('${old}','${client}','${worker}','${admin}','open',1200,1000,1200,2);
    INSERT INTO installments(loan_id,number,amount,status) VALUES('${old}',1,600,'partial'),('${old}',2,600,'pending');
    INSERT INTO daily_cash(cash_date,worker_id,admin_id,status,opening_balance)
      VALUES('2026-11-11','${worker}','${admin}','open',-500);
    INSERT INTO cash_balance(worker_id,admin_id,available_cash,ledger_base_amount)
      VALUES('${worker}','${admin}',${available},${base});
  `);
  return db;
}

async function renew(db: PGlite, paid: number, amount: number) {
  return db.query<{ result: { new_loan_id: string; released_amount: number } }>(
    `SELECT renew_loan_tx($1::uuid,'2026-11-11',$2::numeric,$3::numeric,'fixed',0,$3::numeric,1,'daily','2026-11-12',
      jsonb_build_array(jsonb_build_object('number',1,'amount',$3::numeric,'due_date','2026-11-12')),NULL,NULL) AS result`,
    [old, paid, amount],
  );
}

async function balance(db: PGlite) {
  return Number((await db.query<{ available_cash: string }>("SELECT available_cash FROM cash_balance")).rows[0]?.available_cash);
}

describe("renovação usa caixa corrente — PostgreSQL isolado", () => {
  it("Brandon: saldo atual 2630 permite liberação apesar de abertura histórica negativa", async () => {
    const db = await setup();
    try {
      await renew(db, 200, 4000); // absorve 1000, libera 3000, recebe 200
      expect(await balance(db)).toBe(2630 + 200 - 3000 + 400); // insufficient scenario corrected below
    } finally { await db.close(); }
  }, 20000);

  it("pagamento recebido financia a liberação e saldo é atualizado uma única vez", async () => {
    const db = await setup(100);
    try {
      await renew(db, 200, 1250); // libera 250, saldo 100+200-250=50
      expect(await balance(db)).toBe(50);
      expect((await db.query("SELECT * FROM balance_writes")).rows).toHaveLength(1);
      expect((await db.query("SELECT * FROM cash_movements")).rows).toHaveLength(2);
      expect((await db.query("SELECT * FROM audit_logs")).rows).toHaveLength(1);
    } finally { await db.close(); }
  }, 20000);

  it("insuficiência informa falta exata e desfaz toda a tentativa", async () => {
    const db = await setup(100);
    try {
      await expect(renew(db, 200, 1350)).rejects.toMatchObject({ hint: "CASH_INSUFFICIENT", detail: expect.stringContaining('"missing_amount": 50.00') });
      expect(await balance(db)).toBe(100);
      expect((await db.query("SELECT * FROM loans")).rows).toHaveLength(1);
      expect((await db.query("SELECT * FROM cash_movements")).rows).toHaveLength(0);
    } finally { await db.close(); }
  }, 20000);

  it("divergência real não é classificada como saldo insuficiente", async () => {
    const db = await setup(100, 90);
    try {
      await expect(renew(db, 200, 1250)).rejects.toMatchObject({ message: expect.stringContaining("não corresponde ao saldo-base") });
      expect(await balance(db)).toBe(100);
    } finally { await db.close(); }
  }, 20000);

  it("zero recebido não cria pagamento fictício nem duplica uma renovação repetida", async () => {
    const db = await setup();
    try {
      await renew(db, 0, 1500);
      expect(await balance(db)).toBe(2330);
      expect((await db.query("SELECT * FROM cash_movements")).rows).toHaveLength(1);
      await expect(renew(db, 0, 1500)).rejects.toThrow("já foi quitado ou renovado");
      expect(await balance(db)).toBe(2330);
    } finally { await db.close(); }
  }, 20000);

  it("mantém bloqueio de caixa fechado", async () => {
    const db = await setup();
    try {
      await db.exec("UPDATE daily_cash SET status='closed'");
      await expect(renew(db, 200, 1250)).rejects.toThrow("Não existe caixa aberto");
      expect(await balance(db)).toBe(2630);
    } finally { await db.close(); }
  }, 20000);
});