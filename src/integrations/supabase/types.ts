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
      audit_logs: {
        Row: {
          action_type: string
          created_at: string
          entity_id: string | null
          entity_type: string
          id: string
          new_value: Json | null
          observation: string | null
          old_value: Json | null
          user_id: string | null
          user_role: string | null
          worker_id: string | null
        }
        Insert: {
          action_type: string
          created_at?: string
          entity_id?: string | null
          entity_type: string
          id?: string
          new_value?: Json | null
          observation?: string | null
          old_value?: Json | null
          user_id?: string | null
          user_role?: string | null
          worker_id?: string | null
        }
        Update: {
          action_type?: string
          created_at?: string
          entity_id?: string | null
          entity_type?: string
          id?: string
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
          available_cash: number
          id: string
          interest_receivable: number
          money_lent: number
          penalty_receivable: number
          updated_at: string
          worker_id: string | null
        }
        Insert: {
          available_cash?: number
          id?: string
          interest_receivable?: number
          money_lent?: number
          penalty_receivable?: number
          updated_at?: string
          worker_id?: string | null
        }
        Update: {
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
          amount: number
          cash_date: string
          client_id: string | null
          created_at: string
          daily_event_id: string | null
          id: string
          installment_id: string | null
          loan_id: string | null
          observation: string | null
          type: string
          user_id: string | null
          worker_id: string | null
        }
        Insert: {
          amount: number
          cash_date?: string
          client_id?: string | null
          created_at?: string
          daily_event_id?: string | null
          id?: string
          installment_id?: string | null
          loan_id?: string | null
          observation?: string | null
          type: string
          user_id?: string | null
          worker_id?: string | null
        }
        Update: {
          amount?: number
          cash_date?: string
          client_id?: string | null
          created_at?: string
          daily_event_id?: string | null
          id?: string
          installment_id?: string | null
          loan_id?: string | null
          observation?: string | null
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
          client_code: number | null
          created_at: string
          id: string
          name: string
          notes: string | null
          phone: string | null
          route_id: string | null
          user_id: string | null
          worker_id: string | null
        }
        Insert: {
          client_code?: number | null
          created_at?: string
          id?: string
          name: string
          notes?: string | null
          phone?: string | null
          route_id?: string | null
          user_id?: string | null
          worker_id?: string | null
        }
        Update: {
          client_code?: number | null
          created_at?: string
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
          cash_date: string
          closed_at: string | null
          created_at: string
          id: string
          status: string
          summary: string | null
          total_items_treated: number
          total_not_paid_count: number
          total_penalty_received: number
          total_received: number
          user_id: string | null
          worker_id: string | null
        }
        Insert: {
          cash_date: string
          closed_at?: string | null
          created_at?: string
          id?: string
          status?: string
          summary?: string | null
          total_items_treated?: number
          total_not_paid_count?: number
          total_penalty_received?: number
          total_received?: number
          user_id?: string | null
          worker_id?: string | null
        }
        Update: {
          cash_date?: string
          closed_at?: string | null
          created_at?: string
          id?: string
          status?: string
          summary?: string | null
          total_items_treated?: number
          total_not_paid_count?: number
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
      daily_events: {
        Row: {
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
          observation: string | null
          origin: string | null
          user_id: string | null
          worker_id: string | null
        }
        Insert: {
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
          observation?: string | null
          origin?: string | null
          user_id?: string | null
          worker_id?: string | null
        }
        Update: {
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
          observation?: string | null
          origin?: string | null
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
      installments: {
        Row: {
          amount: number
          created_at: string
          due_date: string
          id: string
          is_penalty: boolean
          loan_id: string
          number: number
          paid_amount: number
          paid_at: string | null
          penalty_amount: number
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
          paid_amount?: number
          paid_at?: string | null
          penalty_amount?: number
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
          paid_amount?: number
          paid_at?: string | null
          penalty_amount?: number
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
      loans: {
        Row: {
          amount: number
          client_id: string
          created_at: string
          first_due_date: string | null
          id: string
          installment_count: number
          interest_type: string
          interest_value: number
          is_cravo: boolean
          loan_date: string
          payment_type: string
          remaining_balance: number
          renewed_from_loan_id: string | null
          route_id: string | null
          status: string
          total_amount: number
          user_id: string | null
          worker_id: string | null
        }
        Insert: {
          amount: number
          client_id: string
          created_at?: string
          first_due_date?: string | null
          id?: string
          installment_count: number
          interest_type: string
          interest_value: number
          is_cravo?: boolean
          loan_date?: string
          payment_type: string
          remaining_balance?: number
          renewed_from_loan_id?: string | null
          route_id?: string | null
          status?: string
          total_amount: number
          user_id?: string | null
          worker_id?: string | null
        }
        Update: {
          amount?: number
          client_id?: string
          created_at?: string
          first_due_date?: string | null
          id?: string
          installment_count?: number
          interest_type?: string
          interest_value?: number
          is_cravo?: boolean
          loan_date?: string
          payment_type?: string
          remaining_balance?: number
          renewed_from_loan_id?: string | null
          route_id?: string | null
          status?: string
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
      penalties: {
        Row: {
          amount: number
          created_at: string
          id: string
          installment_id: string
          loan_id: string
          observation: string | null
          user_id: string | null
          worker_id: string | null
        }
        Insert: {
          amount: number
          created_at?: string
          id?: string
          installment_id: string
          loan_id: string
          observation?: string | null
          user_id?: string | null
          worker_id?: string | null
        }
        Update: {
          amount?: number
          created_at?: string
          id?: string
          installment_id?: string
          loan_id?: string
          observation?: string | null
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
          created_at: string
          id: string
          route_number: string
          status: string
          user_id: string | null
          worker_id: string | null
          worker_name: string
        }
        Insert: {
          created_at?: string
          id?: string
          route_number: string
          status?: string
          user_id?: string | null
          worker_id?: string | null
          worker_name: string
        }
        Update: {
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
          created_at: string
          created_by: string | null
          id: string
          login_codigo: string
          reason: string
          temp_password: string
          worker_id: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          id?: string
          login_codigo: string
          reason?: string
          temp_password: string
          worker_id: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          id?: string
          login_codigo?: string
          reason?: string
          temp_password?: string
          worker_id?: string
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
          auth_user_id: string | null
          created_at: string
          created_by: string | null
          id: string
          login_codigo: string
          nome: string
          notas: string | null
          synthetic_email: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          auth_user_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          login_codigo: string
          nome: string
          notas?: string | null
          synthetic_email: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          auth_user_id?: string | null
          created_at?: string
          created_by?: string | null
          id?: string
          login_codigo?: string
          nome?: string
          notas?: string | null
          synthetic_email?: string
          updated_at?: string
        }
        Relationships: []
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      admin_assign_client_codes: { Args: never; Returns: number }
      admin_list_workers: {
        Args: never
        Returns: {
          active: boolean
          id: string
          login_codigo: string
          nome: string
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
      reverse_loan_payment: {
        Args: { p_amount: number; p_loan_id: string }
        Returns: number
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
    }
    Enums: {
      app_role: "admin" | "operador" | "trabalhador"
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
      app_role: ["admin", "operador", "trabalhador"],
    },
  },
} as const
