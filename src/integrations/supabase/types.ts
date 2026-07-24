export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.1"
  }
  public: {
    Tables: {
      admins: {
        Row: {
          active: boolean
          auth_user_id: string | null
          created_at: string
          created_by: string | null
          email_real: string
          id: string
          login_codigo: string | null
          nome: string
          notas: string | null
          temporary_password: boolean
          updated_at: string
        }
        Insert: {
          active?: boolean
          auth_user_id?: string | null
          created_at?: string
          created_by?: string | null
          email_real: string
          id?: string
          login_codigo?: string | null
          nome: string
          notas?: string | null
          temporary_password?: boolean
          updated_at?: string
        }
        Update: {
          active?: boolean
          auth_user_id?: string | null
          created_at?: string
          created_by?: string | null
          email_real?: string
          id?: string
          login_codigo?: string | null
          nome?: string
          notas?: string | null
          temporary_password?: boolean
          updated_at?: string
        }
        Relationships: []
      }
      audit_logs: {
        Row: {
          action_type: string
          admin_id: string | null
          created_at: string
          entity_id: string | null
          entity_type: string
          id: string
          metadata: Json | null
          new_value: Json | null
          observation: string | null
          old_value: Json | null
          user_id: string | null
          user_role: string | null
          worker_id: string | null
        }
        Insert: {
          action_type: string
          admin_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type: string
          id?: string
          metadata?: Json | null
          new_value?: Json | null
          observation?: string | null
          old_value?: Json | null
          user_id?: string | null
          user_role?: string | null
          worker_id?: string | null
        }
        Update: {
          action_type?: string
          admin_id?: string | null
          created_at?: string
          entity_id?: string | null
          entity_type?: string
          id?: string
          metadata?: Json | null
          new_value?: Json | null
          observation?: string | null
          old_value?: Json | null
          user_id?: string | null
          user_role?: string | null
          worker_id?: string | null
        }
        Relationships: []
      }
      cash_balance: {
        Row: {
          admin_id: string | null
          available_cash: number
          id: string
          interest_receivable: number
          money_lent: number
          penalty_receivable: number
          updated_at: string
          worker_id: string | null
        }
        Insert: {
          admin_id?: string | null
          available_cash?: number
          id?: string
          interest_receivable?: number
          money_lent?: number
          penalty_receivable?: number
          updated_at?: string
          worker_id?: string | null
        }
        Update: {
          admin_id?: string | null
          available_cash?: number
          id?: string
          interest_receivable?: number
          money_lent?: number
          penalty_receivable?: number
          updated_at?: string
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cash_balance_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "workers"
            referencedColumns: ["id"]
          },
        ]
      }
      cash_movements: {
        Row: {
          admin_id: string | null
          amount: number
          cash_date: string
          client_id: string | null
          created_at: string
          daily_event_id: string | null
          id: string
          installment_id: string | null
          loan_id: string | null
          observation: string | null
          reversed_at: string | null
          reversed_by: string | null
          type: string
          user_id: string | null
          worker_id: string | null
        }
        Insert: {
          admin_id?: string | null
          amount: number
          cash_date?: string
          client_id?: string | null
          created_at?: string
          daily_event_id?: string | null
          id?: string
          installment_id?: string | null
          loan_id?: string | null
          observation?: string | null
          reversed_at?: string | null
          reversed_by?: string | null
          type: string
          user_id?: string | null
          worker_id?: string | null
        }
        Update: {
          admin_id?: string | null
          amount?: number
          cash_date?: string
          client_id?: string | null
          created_at?: string
          daily_event_id?: string | null
          id?: string
          installment_id?: string | null
          loan_id?: string | null
          observation?: string | null
          reversed_at?: string | null
          reversed_by?: string | null
          type?: string
          user_id?: string | null
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cash_movements_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cash_movements_daily_event_id_fkey"
            columns: ["daily_event_id"]
            isOneToOne: false
            referencedRelation: "daily_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cash_movements_installment_id_fkey"
            columns: ["installment_id"]
            isOneToOne: false
            referencedRelation: "installments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cash_movements_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "loans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "cash_movements_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "workers"
            referencedColumns: ["id"]
          },
        ]
      }
      cash_reopen_requests: {
        Row: {
          admin_id: string | null
          cash_date: string
          created_at: string
          id: string
          reason: string
          requested_at: string
          requested_by: string | null
          review_note: string | null
          reviewed_at: string | null
          reviewed_by: string | null
          status: string
          updated_at: string
          worker_id: string | null
          worker_name: string | null
        }
        Insert: {
          admin_id?: string | null
          cash_date: string
          created_at?: string
          id?: string
          reason: string
          requested_at?: string
          requested_by?: string | null
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          updated_at?: string
          worker_id?: string | null
          worker_name?: string | null
        }
        Update: {
          admin_id?: string | null
          cash_date?: string
          created_at?: string
          id?: string
          reason?: string
          requested_at?: string
          requested_by?: string | null
          review_note?: string | null
          reviewed_at?: string | null
          reviewed_by?: string | null
          status?: string
          updated_at?: string
          worker_id?: string | null
          worker_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "cash_reopen_requests_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "workers"
            referencedColumns: ["id"]
          },
        ]
      }
      client_attachments: {
        Row: {
          admin_id: string | null
          category: string | null
          client_id: string
          deleted_at: string | null
          deleted_by: string | null
          file_name: string
          file_size: number | null
          file_type: string | null
          id: string
          storage_path: string
          uploaded_at: string
          uploaded_by: string | null
          worker_id: string | null
        }
        Insert: {
          admin_id?: string | null
          category?: string | null
          client_id: string
          deleted_at?: string | null
          deleted_by?: string | null
          file_name: string
          file_size?: number | null
          file_type?: string | null
          id?: string
          storage_path: string
          uploaded_at?: string
          uploaded_by?: string | null
          worker_id?: string | null
        }
        Update: {
          admin_id?: string | null
          category?: string | null
          client_id?: string
          deleted_at?: string | null
          deleted_by?: string | null
          file_name?: string
          file_size?: number | null
          file_type?: string | null
          id?: string
          storage_path?: string
          uploaded_at?: string
          uploaded_by?: string | null
          worker_id?: string | null
        }
        Relationships: []
      }
      client_transfers: {
        Row: {
          client_id: string
          created_at: string
          from_worker_id: string | null
          id: string
          loan_id: string | null
          observation: string | null
          to_worker_id: string
          transferred_by: string
        }
        Insert: {
          client_id: string
          created_at?: string
          from_worker_id?: string | null
          id?: string
          loan_id?: string | null
          observation?: string | null
          to_worker_id: string
          transferred_by: string
        }
        Update: {
          client_id?: string
          created_at?: string
          from_worker_id?: string | null
          id?: string
          loan_id?: string | null
          observation?: string | null
          to_worker_id?: string
          transferred_by?: string
        }
        Relationships: []
      }
      clients: {
        Row: {
          address: string | null
          admin_id: string | null
          archived_at: string | null
          archived_by: string | null
          client_code: number | null
          created_at: string
          doc_primary_number: string | null
          doc_primary_type: string | null
          doc_secondary_number: string | null
          doc_secondary_type: string | null
          full_name: string | null
          id: string
          name: string
          notes: string | null
          phone: string | null
          route_id: string | null
          user_id: string | null
          worker_id: string | null
        }
        Insert: {
          address?: string | null
          admin_id?: string | null
          archived_at?: string | null
          archived_by?: string | null
          client_code?: number | null
          created_at?: string
          doc_primary_number?: string | null
          doc_primary_type?: string | null
          doc_secondary_number?: string | null
          doc_secondary_type?: string | null
          full_name?: string | null
          id?: string
          name: string
          notes?: string | null
          phone?: string | null
          route_id?: string | null
          user_id?: string | null
          worker_id?: string | null
        }
        Update: {
          address?: string | null
          admin_id?: string | null
          archived_at?: string | null
          archived_by?: string | null
          client_code?: number | null
          created_at?: string
          doc_primary_number?: string | null
          doc_primary_type?: string | null
          doc_secondary_number?: string | null
          doc_secondary_type?: string | null
          full_name?: string | null
          id?: string
          name?: string
          notes?: string | null
          phone?: string | null
          route_id?: string | null
          user_id?: string | null
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "clients_route_id_fkey"
            columns: ["route_id"]
            isOneToOne: false
            referencedRelation: "routes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "clients_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "workers"
            referencedColumns: ["id"]
          },
        ]
      }
      daily_cash: {
        Row: {
          admin_id: string | null
          cancellation_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          cash_date: string
          closed_at: string | null
          closed_by: string | null
          closing_difference: number | null
          closing_note: string | null
          counted_closing_balance: number | null
          created_at: string
          expected_closing_balance: number
          id: string
          opened_at: string | null
          opened_by: string | null
          opening_balance: number
          reopen_reason: string | null
          reopened_at: string | null
          reopened_by: string | null
          status: string
          summary: string | null
          total_events_count: number
          total_in: number
          total_items_treated: number
          total_lent: number
          total_manual_in: number
          total_manual_out: number
          total_not_paid_count: number
          total_out: number
          total_penalty_received: number
          total_received: number
          user_id: string | null
          worker_id: string | null
        }
        Insert: {
          admin_id?: string | null
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          cash_date: string
          closed_at?: string | null
          closed_by?: string | null
          closing_difference?: number | null
          closing_note?: string | null
          counted_closing_balance?: number | null
          created_at?: string
          expected_closing_balance?: number
          id?: string
          opened_at?: string | null
          opened_by?: string | null
          opening_balance?: number
          reopen_reason?: string | null
          reopened_at?: string | null
          reopened_by?: string | null
          status?: string
          summary?: string | null
          total_events_count?: number
          total_in?: number
          total_items_treated?: number
          total_lent?: number
          total_manual_in?: number
          total_manual_out?: number
          total_not_paid_count?: number
          total_out?: number
          total_penalty_received?: number
          total_received?: number
          user_id?: string | null
          worker_id?: string | null
        }
        Update: {
          admin_id?: string | null
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          cash_date?: string
          closed_at?: string | null
          closed_by?: string | null
          closing_difference?: number | null
          closing_note?: string | null
          counted_closing_balance?: number | null
          created_at?: string
          expected_closing_balance?: number
          id?: string
          opened_at?: string | null
          opened_by?: string | null
          opening_balance?: number
          reopen_reason?: string | null
          reopened_at?: string | null
          reopened_by?: string | null
          status?: string
          summary?: string | null
          total_events_count?: number
          total_in?: number
          total_items_treated?: number
          total_lent?: number
          total_manual_in?: number
          total_manual_out?: number
          total_not_paid_count?: number
          total_out?: number
          total_penalty_received?: number
          total_received?: number
          user_id?: string | null
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "daily_cash_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "workers"
            referencedColumns: ["id"]
          },
        ]
      }
      daily_cash_snapshots: {
        Row: {
          admin_id: string | null
          cash_date: string
          closed_at: string
          closed_by: string | null
          created_at: string
          daily_cash_id: string
          id: string
          payload: Json
          reopen_reason: string | null
          updated_at: string
          version: number
          worker_id: string | null
        }
        Insert: {
          admin_id?: string | null
          cash_date: string
          closed_at?: string
          closed_by?: string | null
          created_at?: string
          daily_cash_id: string
          id?: string
          payload: Json
          reopen_reason?: string | null
          updated_at?: string
          version?: number
          worker_id?: string | null
        }
        Update: {
          admin_id?: string | null
          cash_date?: string
          closed_at?: string
          closed_by?: string | null
          created_at?: string
          daily_cash_id?: string
          id?: string
          payload?: Json
          reopen_reason?: string | null
          updated_at?: string
          version?: number
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "daily_cash_snapshots_daily_cash_id_fkey"
            columns: ["daily_cash_id"]
            isOneToOne: false
            referencedRelation: "daily_cash"
            referencedColumns: ["id"]
          },
        ]
      }
      daily_events: {
        Row: {
          admin_id: string | null
          amount_in: number
          amount_out: number
          cash_date: string
          cash_movement_id: string | null
          client_id: string | null
          created_at: string
          event_type: string
          id: string
          installment_id: string | null
          loan_id: string | null
          metadata: Json | null
          observation: string | null
          origin: string | null
          reversed_at: string | null
          user_id: string | null
          worker_id: string | null
        }
        Insert: {
          admin_id?: string | null
          amount_in?: number
          amount_out?: number
          cash_date?: string
          cash_movement_id?: string | null
          client_id?: string | null
          created_at?: string
          event_type: string
          id?: string
          installment_id?: string | null
          loan_id?: string | null
          metadata?: Json | null
          observation?: string | null
          origin?: string | null
          reversed_at?: string | null
          user_id?: string | null
          worker_id?: string | null
        }
        Update: {
          admin_id?: string | null
          amount_in?: number
          amount_out?: number
          cash_date?: string
          cash_movement_id?: string | null
          client_id?: string | null
          created_at?: string
          event_type?: string
          id?: string
          installment_id?: string | null
          loan_id?: string | null
          metadata?: Json | null
          observation?: string | null
          origin?: string | null
          reversed_at?: string | null
          user_id?: string | null
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "daily_events_cash_movement_id_fkey"
            columns: ["cash_movement_id"]
            isOneToOne: false
            referencedRelation: "cash_movements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_events_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_events_installment_id_fkey"
            columns: ["installment_id"]
            isOneToOne: false
            referencedRelation: "installments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_events_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "loans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "daily_events_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "workers"
            referencedColumns: ["id"]
          },
        ]
      }
      installment_reminders: {
        Row: {
          client_id: string | null
          created_at: string
          id: string
          installment_id: string
          loan_id: string
          reminded_at: string
          reminded_by: string | null
          reminded_by_name: string | null
          worker_id: string | null
        }
        Insert: {
          client_id?: string | null
          created_at?: string
          id?: string
          installment_id: string
          loan_id: string
          reminded_at?: string
          reminded_by?: string | null
          reminded_by_name?: string | null
          worker_id?: string | null
        }
        Update: {
          client_id?: string | null
          created_at?: string
          id?: string
          installment_id?: string
          loan_id?: string
          reminded_at?: string
          reminded_by?: string | null
          reminded_by_name?: string | null
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "installment_reminders_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "installment_reminders_installment_id_fkey"
            columns: ["installment_id"]
            isOneToOne: true
            referencedRelation: "installments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "installment_reminders_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "loans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "installment_reminders_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "workers"
            referencedColumns: ["id"]
          },
        ]
      }
      installment_reschedules: {
        Row: {
          admin_id: string | null
          admin_note: string | null
          approved_by: string | null
          approved_due_date: string | null
          created_at: string
          id: string
          installment_id: string
          loan_id: string
          original_due_date: string
          reason: string | null
          requested_due_date: string
          resolved_at: string | null
          status: string
          worker_id: string
        }
        Insert: {
          admin_id?: string | null
          admin_note?: string | null
          approved_by?: string | null
          approved_due_date?: string | null
          created_at?: string
          id?: string
          installment_id: string
          loan_id: string
          original_due_date: string
          reason?: string | null
          requested_due_date: string
          resolved_at?: string | null
          status?: string
          worker_id: string
        }
        Update: {
          admin_id?: string | null
          admin_note?: string | null
          approved_by?: string | null
          approved_due_date?: string | null
          created_at?: string
          id?: string
          installment_id?: string
          loan_id?: string
          original_due_date?: string
          reason?: string | null
          requested_due_date?: string
          resolved_at?: string | null
          status?: string
          worker_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "installment_reschedules_admin_id_fkey"
            columns: ["admin_id"]
            isOneToOne: false
            referencedRelation: "admins"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "installment_reschedules_approved_by_fkey"
            columns: ["approved_by"]
            isOneToOne: false
            referencedRelation: "admins"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "installment_reschedules_installment_id_fkey"
            columns: ["installment_id"]
            isOneToOne: false
            referencedRelation: "installments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "installment_reschedules_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "loans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "installment_reschedules_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "workers"
            referencedColumns: ["id"]
          },
        ]
      }
      installments: {
        Row: {
          amount: number
          created_at: string
          due_date: string
          id: string
          is_penalty: boolean
          loan_id: string
          number: number
          original_due_date: string | null
          paid_amount: number
          paid_at: string | null
          penalty_amount: number
          reschedule_count: number
          rescheduled: boolean
          status: string
        }
        Insert: {
          amount: number
          created_at?: string
          due_date: string
          id?: string
          is_penalty?: boolean
          loan_id: string
          number: number
          original_due_date?: string | null
          paid_amount?: number
          paid_at?: string | null
          penalty_amount?: number
          reschedule_count?: number
          rescheduled?: boolean
          status?: string
        }
        Update: {
          amount?: number
          created_at?: string
          due_date?: string
          id?: string
          is_penalty?: boolean
          loan_id?: string
          number?: number
          original_due_date?: string | null
          paid_amount?: number
          paid_at?: string | null
          penalty_amount?: number
          reschedule_count?: number
          rescheduled?: boolean
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "installments_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "loans"
            referencedColumns: ["id"]
          },
        ]
      }
      loan_renegotiations: {
        Row: {
          absorbed_from_new: number
          admin_id: string | null
          client_paid_amount: number
          created_at: string
          id: string
          new_amount: number | null
          new_installment_count: number | null
          new_interest_type: string | null
          new_interest_value: number | null
          new_loan_id: string | null
          new_payment_type: string | null
          new_total_amount: number | null
          original_installment_count: number
          original_interest_type: string
          original_interest_value: number
          original_loan_id: string
          original_payment_type: string
          original_remaining_balance: number
          original_total_amount: number
          reason: string | null
          released_to_client: number
          type: string
          worker_id: string | null
        }
        Insert: {
          absorbed_from_new?: number
          admin_id?: string | null
          client_paid_amount?: number
          created_at?: string
          id?: string
          new_amount?: number | null
          new_installment_count?: number | null
          new_interest_type?: string | null
          new_interest_value?: number | null
          new_loan_id?: string | null
          new_payment_type?: string | null
          new_total_amount?: number | null
          original_installment_count: number
          original_interest_type: string
          original_interest_value: number
          original_loan_id: string
          original_payment_type: string
          original_remaining_balance: number
          original_total_amount: number
          reason?: string | null
          released_to_client?: number
          type: string
          worker_id?: string | null
        }
        Update: {
          absorbed_from_new?: number
          admin_id?: string | null
          client_paid_amount?: number
          created_at?: string
          id?: string
          new_amount?: number | null
          new_installment_count?: number | null
          new_interest_type?: string | null
          new_interest_value?: number | null
          new_loan_id?: string | null
          new_payment_type?: string | null
          new_total_amount?: number | null
          original_installment_count?: number
          original_interest_type?: string
          original_interest_value?: number
          original_loan_id?: string
          original_payment_type?: string
          original_remaining_balance?: number
          original_total_amount?: number
          reason?: string | null
          released_to_client?: number
          type?: string
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "loan_renegotiations_admin_id_fkey"
            columns: ["admin_id"]
            isOneToOne: false
            referencedRelation: "admins"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loan_renegotiations_new_loan_id_fkey"
            columns: ["new_loan_id"]
            isOneToOne: false
            referencedRelation: "loans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loan_renegotiations_original_loan_id_fkey"
            columns: ["original_loan_id"]
            isOneToOne: false
            referencedRelation: "loans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loan_renegotiations_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "workers"
            referencedColumns: ["id"]
          },
        ]
      }
      loans: {
        Row: {
          admin_id: string | null
          amount: number
          amount_already_paid: number
          client_id: string
          created_at: string
          first_due_date: string | null
          id: string
          imported_at: string | null
          initial_remaining_balance: number | null
          installment_count: number
          interest_type: string
          interest_value: number
          is_cravo: boolean
          is_imported_ongoing: boolean
          loan_date: string
          observation: string | null
          payment_type: string
          remaining_balance: number
          renewed_from_loan_id: string | null
          route_id: string | null
          status: string
          status_detail: string | null
          total_amount: number
          user_id: string | null
          worker_id: string | null
        }
        Insert: {
          admin_id?: string | null
          amount: number
          amount_already_paid?: number
          client_id: string
          created_at?: string
          first_due_date?: string | null
          id?: string
          imported_at?: string | null
          initial_remaining_balance?: number | null
          installment_count: number
          interest_type: string
          interest_value: number
          is_cravo?: boolean
          is_imported_ongoing?: boolean
          loan_date?: string
          observation?: string | null
          payment_type: string
          remaining_balance?: number
          renewed_from_loan_id?: string | null
          route_id?: string | null
          status?: string
          status_detail?: string | null
          total_amount: number
          user_id?: string | null
          worker_id?: string | null
        }
        Update: {
          admin_id?: string | null
          amount?: number
          amount_already_paid?: number
          client_id?: string
          created_at?: string
          first_due_date?: string | null
          id?: string
          imported_at?: string | null
          initial_remaining_balance?: number | null
          installment_count?: number
          interest_type?: string
          interest_value?: number
          is_cravo?: boolean
          is_imported_ongoing?: boolean
          loan_date?: string
          observation?: string | null
          payment_type?: string
          remaining_balance?: number
          renewed_from_loan_id?: string | null
          route_id?: string | null
          status?: string
          status_detail?: string | null
          total_amount?: number
          user_id?: string | null
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "loans_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loans_renewed_from_loan_id_fkey"
            columns: ["renewed_from_loan_id"]
            isOneToOne: false
            referencedRelation: "loans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loans_route_id_fkey"
            columns: ["route_id"]
            isOneToOne: false
            referencedRelation: "routes"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "loans_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "workers"
            referencedColumns: ["id"]
          },
        ]
      }
      not_paid_marks: {
        Row: {
          admin_id: string | null
          client_id: string
          created_at: string
          id: string
          installment_id: string
          loan_id: string
          mark_date: string
          observation: string | null
          user_id: string | null
          worker_id: string | null
        }
        Insert: {
          admin_id?: string | null
          client_id: string
          created_at?: string
          id?: string
          installment_id: string
          loan_id: string
          mark_date: string
          observation?: string | null
          user_id?: string | null
          worker_id?: string | null
        }
        Update: {
          admin_id?: string | null
          client_id?: string
          created_at?: string
          id?: string
          installment_id?: string
          loan_id?: string
          mark_date?: string
          observation?: string | null
          user_id?: string | null
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "not_paid_marks_client_id_fkey"
            columns: ["client_id"]
            isOneToOne: false
            referencedRelation: "clients"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "not_paid_marks_installment_id_fkey"
            columns: ["installment_id"]
            isOneToOne: false
            referencedRelation: "installments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "not_paid_marks_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "loans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "not_paid_marks_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "workers"
            referencedColumns: ["id"]
          },
        ]
      }
      password_recovery_requests: {
        Row: {
          email_informado: string | null
          id: string
          login_informado: string | null
          nome_informado: string | null
          notas: string | null
          requested_at: string
          resolved_at: string | null
          resolved_by: string | null
          status: string
          target_admin_id: string | null
          target_role: string | null
          target_user_id: string | null
        }
        Insert: {
          email_informado?: string | null
          id?: string
          login_informado?: string | null
          nome_informado?: string | null
          notas?: string | null
          requested_at?: string
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          target_admin_id?: string | null
          target_role?: string | null
          target_user_id?: string | null
        }
        Update: {
          email_informado?: string | null
          id?: string
          login_informado?: string | null
          nome_informado?: string | null
          notas?: string | null
          requested_at?: string
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
          target_admin_id?: string | null
          target_role?: string | null
          target_user_id?: string | null
        }
        Relationships: []
      }
      penalties: {
        Row: {
          admin_id: string | null
          amount: number
          base_amount: number | null
          cancellation_reason: string | null
          cancelled_at: string | null
          cancelled_by: string | null
          created_at: string
          id: string
          installment_id: string
          loan_id: string
          observation: string | null
          paid: boolean
          paid_amount: number
          paid_at: string | null
          penalty_type: string
          percentage_value: number | null
          user_id: string | null
          worker_id: string | null
        }
        Insert: {
          admin_id?: string | null
          amount: number
          base_amount?: number | null
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          created_at?: string
          id?: string
          installment_id: string
          loan_id: string
          observation?: string | null
          paid?: boolean
          paid_amount?: number
          paid_at?: string | null
          penalty_type?: string
          percentage_value?: number | null
          user_id?: string | null
          worker_id?: string | null
        }
        Update: {
          admin_id?: string | null
          amount?: number
          base_amount?: number | null
          cancellation_reason?: string | null
          cancelled_at?: string | null
          cancelled_by?: string | null
          created_at?: string
          id?: string
          installment_id?: string
          loan_id?: string
          observation?: string | null
          paid?: boolean
          paid_amount?: number
          paid_at?: string | null
          penalty_type?: string
          percentage_value?: number | null
          user_id?: string | null
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "penalties_installment_id_fkey"
            columns: ["installment_id"]
            isOneToOne: false
            referencedRelation: "installments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "penalties_loan_id_fkey"
            columns: ["loan_id"]
            isOneToOne: false
            referencedRelation: "loans"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "penalties_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "workers"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          created_at: string
          display_name: string | null
          email: string
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          display_name?: string | null
          email: string
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          display_name?: string | null
          email?: string
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      route_requests: {
        Row: {
          assigned_route_number: string | null
          created_at: string
          id: string
          status: string
          worker_name: string
        }
        Insert: {
          assigned_route_number?: string | null
          created_at?: string
          id?: string
          status?: string
          worker_name: string
        }
        Update: {
          assigned_route_number?: string | null
          created_at?: string
          id?: string
          status?: string
          worker_name?: string
        }
        Relationships: []
      }
      routes: {
        Row: {
          admin_id: string | null
          created_at: string
          id: string
          route_number: string
          status: string
          user_id: string | null
          worker_id: string | null
          worker_name: string
        }
        Insert: {
          admin_id?: string | null
          created_at?: string
          id?: string
          route_number: string
          status?: string
          user_id?: string | null
          worker_id?: string | null
          worker_name: string
        }
        Update: {
          admin_id?: string | null
          created_at?: string
          id?: string
          route_number?: string
          status?: string
          user_id?: string | null
          worker_id?: string | null
          worker_name?: string
        }
        Relationships: [
          {
            foreignKeyName: "routes_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "workers"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: []
      }
      worker_credentials_log: {
        Row: {
          admin_id: string | null
          auth_user_id: string | null
          created_at: string
          created_by: string | null
          id: string
          login_codigo: string
          nome: string | null
          reason: string
          role: string | null
          status: string
          temp_password: string
          viewed_at: string | null
          worker_id: string | null
        }
        Insert: {
          admin_id?: string | null
          auth_user_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          login_codigo: string
          nome?: string | null
          reason?: string
          role?: string | null
          status?: string
          temp_password: string
          viewed_at?: string | null
          worker_id?: string | null
        }
        Update: {
          admin_id?: string | null
          auth_user_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          login_codigo?: string
          nome?: string | null
          reason?: string
          role?: string | null
          status?: string
          temp_password?: string
          viewed_at?: string | null
          worker_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "worker_credentials_log_worker_id_fkey"
            columns: ["worker_id"]
            isOneToOne: false
            referencedRelation: "workers"
            referencedColumns: ["id"]
          },
        ]
      }
      worker_password_reset_requests: {
        Row: {
          created_at: string
          id: string
          identifier: string
          resolved_at: string | null
          resolved_by: string | null
          status: string
        }
        Insert: {
          created_at?: string
          id?: string
          identifier: string
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
        }
        Update: {
          created_at?: string
          id?: string
          identifier?: string
          resolved_at?: string | null
          resolved_by?: string | null
          status?: string
        }
        Relationships: []
      }
      workers: {
        Row: {
          active: boolean
          archived_at: string | null
          archived_by: string | null
          auth_user_id: string | null
          created_at: string
          created_by: string | null
          id: string
          login_codigo: string
          nome: string
          notas: string | null
          parent_admin_id: string | null
          synthetic_email: string
          temporary_password: boolean
          updated_at: string
        }
        Insert: {
          active?: boolean
          archived_at?: string | null
          archived_by?: string | null
          auth_user_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          login_codigo: string
          nome: string
          notas?: string | null
          parent_admin_id?: string | null
          synthetic_email: string
          temporary_password?: boolean
          updated_at?: string
        }
        Update: {
          active?: boolean
          archived_at?: string | null
          archived_by?: string | null
          auth_user_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          login_codigo?: string
          nome?: string
          notas?: string | null
          parent_admin_id?: string | null
          synthetic_email?: string
          temporary_password?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "workers_parent_admin_id_fkey"
            columns: ["parent_admin_id"]
            isOneToOne: false
            referencedRelation: "admins"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      _cash_is_closed_for: {
        Args: { p_admin_id: string; p_cash_date: string; p_worker_id: string }
        Returns: boolean
      }
      _cash_is_open_for: {
        Args: { p_admin_id: string; p_cash_date: string; p_worker_id: string }
        Returns: boolean
      }
      _daily_cash_emptiness_reason: {
        Args: { p_cash_id: string }
        Returns: string
      }
      _daily_cash_is_empty: { Args: { p_cash_id: string }; Returns: boolean }
      admin_assign_client_codes: { Args: never; Returns: number }
      admin_cleanup_empty_daily_cash: {
        Args: {
          p_admin_id?: string
          p_end: string
          p_start: string
          p_worker_id?: string
        }
        Returns: number
      }
      admin_cleanup_empty_daily_cash_ids: {
        Args: { p_cash_ids: string[] }
        Returns: number
      }
      admin_create_client: {
        Args: {
          p_address?: string
          p_doc_primary_number?: string
          p_doc_primary_type?: string
          p_doc_secondary_number?: string
          p_doc_secondary_type?: string
          p_full_name?: string
          p_name: string
          p_notes?: string
          p_phone?: string
          p_worker_id?: string
        }
        Returns: string
      }
      admin_find_empty_daily_cash: {
        Args: {
          p_admin_id?: string
          p_end: string
          p_start: string
          p_worker_id?: string
        }
        Returns: {
          admin_id: string
          admin_nome: string
          cash_date: string
          id: string
          is_empty: boolean
          opened_at: string
          reason: string
          worker_id: string
          worker_nome: string
        }[]
      }
      admin_find_orphans: {
        Args: never
        Returns: {
          created_at: string
          entity_id: string
          entity_type: string
          label: string
          missing: string
        }[]
      }
      admin_list_workers:
        | {
            Args: never
            Returns: {
              active: boolean
              id: string
              login_codigo: string
              nome: string
            }[]
          }
        | {
            Args: { p_include_archived?: boolean }
            Returns: {
              active: boolean
              archived_at: string
              id: string
              login_codigo: string
              nome: string
              parent_admin_id: string
            }[]
          }
      admin_recalculate_installments: { Args: never; Returns: number }
      admin_recalculate_loans: { Args: never; Returns: number }
      admin_register_worker: {
        Args: {
          p_auth_user_id: string
          p_login_codigo: string
          p_nome: string
          p_notas?: string
          p_synthetic_email: string
        }
        Returns: string
      }
      admin_transfer_client: {
        Args: {
          p_client_id: string
          p_observation?: string
          p_to_worker_id: string
        }
        Returns: string
      }
      apply_loan_payment: {
        Args: { p_amount: number; p_loan_id: string }
        Returns: number
      }
      approve_cash_reopen_request: {
        Args: { p_note?: string; p_request_id: string }
        Returns: string
      }
      archive_worker: {
        Args: { p_cascade?: boolean; p_worker_id: string }
        Returns: Json
      }
      attach_expense_receipt: {
        Args: { p_daily_event_id: string; p_receipt: Json }
        Returns: undefined
      }
      bulk_archive_clients: { Args: { p_client_ids: string[] }; Returns: Json }
      bulk_unarchive_clients: {
        Args: { p_client_ids: string[] }
        Returns: Json
      }
      close_daily_cash: { Args: { p_cash_date: string }; Returns: string }
      close_daily_cash_v2: {
        Args: { p_cash_date: string; p_counted: number; p_note?: string }
        Returns: string
      }
      delete_worker_if_empty: {
        Args: { p_worker_id: string }
        Returns: undefined
      }
      generate_admin_login_codigo: { Args: never; Returns: string }
      generate_worker_login_codigo: { Args: never; Returns: string }
      get_admin_id: { Args: { _user_id: string }; Returns: string }
      get_latest_credential: {
        Args: { p_kind: string; p_target_id: string }
        Returns: {
          created_at: string
          created_by: string
          login_codigo: string
          reason: string
          status: string
          temp_password: string
        }[]
      }
      get_route_installments: {
        Args: { p_cash_date: string }
        Returns: {
          amount: number
          client_id: string
          client_name: string
          due_date: string
          id: string
          is_penalty: boolean
          loan_amount: number
          loan_client_id: string
          loan_id: string
          loan_installment_count: number
          loan_payment_type: string
          loan_remaining_balance: number
          loan_total_amount: number
          number: number
          paid_amount: number
          paid_at: string
          status: string
        }[]
      }
      get_synthetic_email_by_login: {
        Args: { p_login: string }
        Returns: string
      }
      get_worker_id: { Args: { _user_id: string }; Returns: string }
      has_role: {
        Args: {
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_cash_closed: { Args: { p_cash_date: string }; Returns: boolean }
      is_super_admin: { Args: { _user_id: string }; Returns: boolean }
      list_password_recovery_alerts: {
        Args: never
        Returns: {
          email_informado: string
          id: string
          login_informado: string
          nome_informado: string
          requested_at: string
          target_admin_id: string
          target_role: string
        }[]
      }
      list_workers_by_admin:
        | {
            Args: { p_admin_id?: string }
            Returns: {
              active: boolean
              id: string
              login_codigo: string
              nome: string
              parent_admin_id: string
            }[]
          }
        | {
            Args: { p_admin_id?: string; p_include_archived?: boolean }
            Returns: {
              active: boolean
              archived_at: string
              id: string
              login_codigo: string
              nome: string
              parent_admin_id: string
            }[]
          }
      log_audit: {
        Args: {
          p_action: string
          p_entity: string
          p_entity_id?: string
          p_new?: Json
          p_obs?: string
          p_old?: Json
          p_worker_id?: string
        }
        Returns: string
      }
      open_daily_cash: {
        Args: { p_cash_date: string; p_worker_id?: string }
        Returns: string
      }
      redact_old_credentials_log: { Args: never; Returns: number }
      register_expense: {
        Args: {
          p_amount: number
          p_cash_date: string
          p_category: string
          p_description: string
        }
        Returns: Json
      }
      register_recovery_request: {
        Args: { p_email: string; p_login: string; p_nome: string }
        Returns: string
      }
      reject_cash_reopen_request: {
        Args: { p_note?: string; p_request_id: string }
        Returns: string
      }
      reopen_daily_cash: {
        Args: { p_cash_date: string; p_reason: string }
        Returns: string
      }
      reverse_loan_payment: {
        Args: { p_amount: number; p_loan_id: string }
        Returns: number
      }
      set_worker_active: {
        Args: { p_active: boolean; p_worker_id: string }
        Returns: undefined
      }
      super_admin_list_admins: {
        Args: never
        Returns: {
          active: boolean
          created_at: string
          email_real: string
          id: string
          login_codigo: string
          nome: string
        }[]
      }
      super_admin_register_admin: {
        Args: {
          p_auth_user_id: string
          p_email_real: string
          p_login_codigo: string
          p_nome: string
        }
        Returns: string
      }
      super_admin_set_admin_active: {
        Args: { p_active: boolean; p_admin_id: string }
        Returns: undefined
      }
      super_admin_stats_by_admin: {
        Args: { p_end: string; p_start: string }
        Returns: {
          active: boolean
          active_loans: number
          admin_id: string
          admin_nome: string
          total_lent: number
          total_received: number
          workers_count: number
        }[]
      }
      super_admin_update_admin: {
        Args: { p_admin_id: string; p_nome: string; p_notas?: string }
        Returns: undefined
      }
      unarchive_worker: {
        Args: { p_cascade?: boolean; p_worker_id: string }
        Returns: Json
      }
      update_cash_balance_atomic: {
        Args: {
          p_available_cash?: number
          p_interest_receivable?: number
          p_money_lent?: number
          p_penalty_receivable?: number
        }
        Returns: undefined
      }
      worker_create_client: {
        Args: {
          p_address?: string
          p_doc_primary_number?: string
          p_doc_primary_type?: string
          p_doc_secondary_number?: string
          p_doc_secondary_type?: string
          p_full_name?: string
          p_name: string
          p_notes?: string
          p_phone?: string
        }
        Returns: string
      }
    }
    Enums: {
      app_role: "admin" | "operador" | "trabalhador" | "super_admin"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      app_role: ["admin", "operador", "trabalhador", "super_admin"],
    },
  },
} as const
