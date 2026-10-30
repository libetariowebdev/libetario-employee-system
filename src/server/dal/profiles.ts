import { scoped } from '../db';
export async function profileForSession(sessionHash: string, employeeId: string) {
  return scoped(sessionHash, async tx => {
    const profile = await tx.employee_profiles.findUnique({ where: { user_id: employeeId } });
    if (!profile) return null;
    const rates = await tx.employee_rate_history.findMany({ where: { employee_id: employeeId }, orderBy: { effective_from: 'desc' } });
    return { ...profile, rates: rates.map(rate => ({ ...rate, amount: rate.amount.toFixed(4) })) };
  });
}
