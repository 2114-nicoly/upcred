import { useAuth } from "@/hooks/useAuth";
import { useWorkerFilter } from "@/hooks/useWorkerFilter";

/**
 * Escopo EFETIVO usado por todas as telas operacionais (Rota, Caixa, Clientes,
 * Empréstimos, Histórico e Relatórios).
 *
 * Regras:
 * - Trabalhador logado: escopo do próprio login.
 * - Administrador/SuperAdministrador visualizando um trabalhador:
 *   effectiveWorkerId = trabalhador selecionado, effectiveAdminId = empresa dele.
 * - Sem trabalhador selecionado: escopo normal (equipe/empresa/sistema).
 *
 * O usuário autenticado NUNCA é usado como substituto quando existe
 * effectiveWorkerId.
 */
export type EffectiveScope = {
  effectiveWorkerId: string | null;
  effectiveAdminId: string | null;
  /** Admin/SuperAdmin está visualizando os dados de um trabalhador. */
  viewingAsWorker: boolean;
  /** Enquanto visualiza como trabalhador, ações financeiras ficam bloqueadas. */
  readOnly: boolean;
  isPrivileged: boolean;
};

export function useEffectiveScope(): EffectiveScope {
  const { workerId, adminId, isAdmin, isSuperAdmin } = useAuth();
  const { selectedWorkerId, selectedAdminId, selectedWorkerAdminId } = useWorkerFilter();
  const isPrivileged = isAdmin || isSuperAdmin;

  if (!isPrivileged) {
    return {
      effectiveWorkerId: workerId ?? null,
      effectiveAdminId: adminId ?? null,
      viewingAsWorker: false,
      readOnly: false,
      isPrivileged: false,
    };
  }

  // Trabalhador de outra empresa nunca é considerado válido.
  const mismatch =
    !!selectedWorkerId && !!selectedAdminId && !!selectedWorkerAdminId &&
    selectedWorkerAdminId !== selectedAdminId;
  const effectiveWorkerId = selectedWorkerId && !mismatch ? selectedWorkerId : null;
  const effectiveAdminId = effectiveWorkerId
    ? (selectedWorkerAdminId ?? selectedAdminId ?? adminId ?? null)
    : (selectedAdminId ?? adminId ?? null);

  return {
    effectiveWorkerId,
    effectiveAdminId,
    viewingAsWorker: !!effectiveWorkerId,
    readOnly: !!effectiveWorkerId,
    isPrivileged: true,
  };
}
