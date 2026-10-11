import { EntityManager } from 'typeorm';
import { User } from '../users/entities/user.entity';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_WINDOW_STEPS = 1;

export class TwoFactorCodeRejectedError extends Error {
  constructor() {
    super('Invalid two-factor authentication code');
    this.name = 'TwoFactorCodeRejectedError';
  }
}

const NEWER_STEP =
  '("twoFactorLastUsedStep" IS NULL OR "twoFactorLastUsedStep" < :step)';
const CURRENT_STEP_WINDOW =
  'ABS(:step - FLOOR(EXTRACT(EPOCH FROM clock_timestamp()) / :seconds)) <= :window';

export async function consumeTwoFactorStep(
  transaction: EntityManager,
  user: User,
  step: number,
): Promise<void> {
  // Recheck expiry after row-lock waits, and commit consumption with the protected action.
  const consumed = await transaction
    .getRepository(User)
    .createQueryBuilder()
    .update(User)
    .set({ twoFactorLastUsedStep: step })
    .where('id = :userId', { userId: user.id })
    .andWhere('"twoFactorSecret" = :secret', { secret: user.twoFactorSecret })
    .andWhere(NEWER_STEP, { step })
    .andWhere(CURRENT_STEP_WINDOW, {
      seconds: TOTP_STEP_SECONDS,
      window: TOTP_WINDOW_STEPS,
    })
    .execute();
  if (consumed.affected !== 1) throw new TwoFactorCodeRejectedError();
}
