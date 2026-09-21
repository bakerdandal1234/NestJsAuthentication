import {
    ConflictException,
    Injectable,
    UnauthorizedException,
} from '@nestjs/common';
import {
    DataSource,
    EntityManager,
    QueryFailedError,
} from 'typeorm';

import { Customer } from '../customers/entities/customer.entity';
import { CustomerAccount } from './entities/customer-account.entity';
import type { CustomerGoogleProfile } from './interfaces/customer-google-profile.interface';
import {
    CUSTOMER_LOCK_DURATION_MS,
    CUSTOMER_MAX_FAILED_VERIFICATIONS,
} from './customer-auth.constants';

function isUniqueViolation(error: unknown): boolean {
    if (!(error instanceof QueryFailedError)) {
        return false;
    }

    const driverError: unknown = error.driverError;

    return (
        typeof driverError === 'object' &&
        driverError !== null &&
        'code' in driverError &&
        driverError.code === '23505'
    );
}

@Injectable()
export class CustomerAccountsService {
    constructor(private readonly dataSource: DataSource) { }

    /**
     * Internal method: receives the verified profile from our Google
     * strategy. Never expose this method through a public body-based route.
     *
     * Resolves identity only; it does not authenticate a session or
     * bypass the lockout / 2FA checks required before issuing tokens.
     */
    async resolveGoogleAccount(
        profile: CustomerGoogleProfile,
    ): Promise<CustomerAccount> {
        if (
            profile.emailVerified !== true ||
            !profile.googleId?.trim() ||
            !profile.email?.trim()
        ) {
            throw new UnauthorizedException(
                'A verified Google identity is required',
            );
        }

        try {
            return await this.dataSource.transaction((manager) =>
                this.resolveWithinTransaction(manager, profile),
            );
        } catch (error: unknown) {
            if (!isUniqueViolation(error)) {
                throw error;
            }

            // Another simultaneous callback may have created this exact
            // Google account. The failed transaction has already rolled back.
            const existing = await this.dataSource
                .getRepository(CustomerAccount)
                .findOne({
                    where: { googleId: profile.googleId },
                });

            if (existing) {
                return existing;
            }

            throw this.accountConflict();
        }
    }

    private async resolveWithinTransaction(
        manager: EntityManager,
        profile: CustomerGoogleProfile,
    ): Promise<CustomerAccount> {
        const accounts = manager.getRepository(CustomerAccount);
        const customers = manager.getRepository(Customer);

        const existingAccount = await accounts.findOne({
            where: { googleId: profile.googleId },
        });

        if (existingAccount) {
            // Keep the authentication email current without overwriting
            // the customer's business/contact information.
            existingAccount.email = profile.email.trim();
            existingAccount.isEmailVerified = true;

            return accounts.save(existingAccount);
        }

        const email = profile.email.trim();

        const existingCustomer = await customers
            .createQueryBuilder('customer')
            .where('LOWER(customer.email) = LOWER(:email)', { email })
            .getOne();

        if (existingCustomer) {
            throw this.accountConflict();
        }

        const firstName = profile.firstName?.trim();
        const lastName = profile.lastName?.trim();

        // Both fields are required by the current Customer model.
        // Do not invent names or save empty placeholder values.
        // if (!firstName || !lastName) {
        //   throw new BadRequestException(
        //     'Additional customer profile information is required before registration',
        //   );
        // }

        const customer = customers.create({
            firstName: profile.firstName?.trim() || null,
            lastName: profile.lastName?.trim() || null,
            email,
        });

        const savedCustomer = await customers.save(customer);



        const account = accounts.create({
            customerId: savedCustomer.id,
            googleId: profile.googleId,
            email,
            isEmailVerified: true,
            isTwoFactorEnabled: false,
            failedLoginAttempts: 0,
        });

        return accounts.save(account);
    }

    /**
     * Counts one failed LOCAL verification (a wrong 2FA code) and locks the
     * account once there have been too many.
     *
     * Runs on its OWN connection, never inside the verification transaction:
     * that transaction is rolled back when the wrong code is rejected, which
     * would silently undo the counter and stop the lockout from ever
     * accumulating. The caller invokes this after the transaction commits.
     */
    async registerFailedVerification(
        accountId: string,
        currentAttempts: number,
    ): Promise<void> {
        const accounts = this.dataSource.getRepository(CustomerAccount);
        const attempts = currentAttempts + 1;

        if (attempts >= CUSTOMER_MAX_FAILED_VERIFICATIONS) {
            await accounts.update(
                { id: accountId },
                {
                    failedLoginAttempts: 0,
                    lockedUntil: new Date(Date.now() + CUSTOMER_LOCK_DURATION_MS),
                },
            );

            return;
        }

        await accounts.update({ id: accountId }, { failedLoginAttempts: attempts });
    }

    /**
     * Clears the lockout counters after a successful verification. Takes the
     * caller's EntityManager so it commits together with the session being
     * issued.
     *
     * The `() => 'NULL'` form is used because TypeORM's typed update cannot
     * express "set this optional Date column back to NULL" without
     * weakening the entity's types.
     */
    async clearVerificationLockout(
        manager: EntityManager,
        accountId: string,
    ): Promise<void> {
        await manager
            .createQueryBuilder()
            .update(CustomerAccount)
            .set({ failedLoginAttempts: 0, lockedUntil: () => 'NULL' })
            .where('id = :accountId', { accountId })
            .execute();
    }

    private accountConflict(): ConflictException {
        return new ConflictException(
            'Unable to complete registration. Please contact support.',
        );
    }
}