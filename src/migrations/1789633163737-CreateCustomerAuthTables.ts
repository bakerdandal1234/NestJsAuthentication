import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateCustomerAuthTables1789633163737 implements MigrationInterface {
    name = 'CreateCustomerAuthTables1789633163737'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "customer_accounts" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "customerId" uuid NOT NULL, "googleId" character varying NOT NULL, "email" character varying NOT NULL, "isEmailVerified" boolean NOT NULL DEFAULT false, "twoFactorSecret" character varying, "isTwoFactorEnabled" boolean NOT NULL DEFAULT false, "failedLoginAttempts" integer NOT NULL DEFAULT '0', "lockedUntil" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "REL_faa79f189b7dff19db11e5ce6e" UNIQUE ("customerId"), CONSTRAINT "PK_814e5a9128d2a2fffbddffc0a27" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_faa79f189b7dff19db11e5ce6e" ON "customer_accounts" ("customerId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_f240b34c1778f92bfed46c70bc" ON "customer_accounts" ("googleId") `);
        await queryRunner.query(`CREATE TABLE "customer_sessions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "customerAccountId" uuid NOT NULL, "refreshTokenHash" character varying NOT NULL, "userAgent" character varying, "ipAddress" character varying, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "lastUsedAt" TIMESTAMP WITH TIME ZONE, "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "revokedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_c684ecbaa67a634723776229c4c" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_cfd092a52ea1d27f9fdea74f50" ON "customer_sessions" ("customerAccountId") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_9cb2921de210b1619476644b17" ON "customer_sessions" ("refreshTokenHash") `);
        await queryRunner.query(`CREATE TABLE "customer_login_history" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "customerAccountId" uuid NOT NULL, "ipAddress" character varying, "userAgent" character varying, "success" boolean NOT NULL DEFAULT true, "failureReason" character varying, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_932a0683071e74d19c3bdec97ab" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "idx_customer_login_history_account_created_at" ON "customer_login_history" ("customerAccountId", "createdAt") `);
        await queryRunner.query(`ALTER TABLE "customers" ALTER COLUMN "email" SET NOT NULL`);
        await queryRunner.query(`ALTER TABLE "customer_accounts" ADD CONSTRAINT "FK_faa79f189b7dff19db11e5ce6e6" FOREIGN KEY ("customerId") REFERENCES "customers"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "customer_sessions" ADD CONSTRAINT "FK_cfd092a52ea1d27f9fdea74f50d" FOREIGN KEY ("customerAccountId") REFERENCES "customer_accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "customer_login_history" ADD CONSTRAINT "FK_5d56823987c955c0c5dd9a3490a" FOREIGN KEY ("customerAccountId") REFERENCES "customer_accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "customer_login_history" DROP CONSTRAINT "FK_5d56823987c955c0c5dd9a3490a"`);
        await queryRunner.query(`ALTER TABLE "customer_sessions" DROP CONSTRAINT "FK_cfd092a52ea1d27f9fdea74f50d"`);
        await queryRunner.query(`ALTER TABLE "customer_accounts" DROP CONSTRAINT "FK_faa79f189b7dff19db11e5ce6e6"`);
        await queryRunner.query(`ALTER TABLE "customers" ALTER COLUMN "email" DROP NOT NULL`);
        await queryRunner.query(`DROP INDEX "public"."idx_customer_login_history_account_created_at"`);
        await queryRunner.query(`DROP TABLE "customer_login_history"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_9cb2921de210b1619476644b17"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_cfd092a52ea1d27f9fdea74f50"`);
        await queryRunner.query(`DROP TABLE "customer_sessions"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_f240b34c1778f92bfed46c70bc"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_faa79f189b7dff19db11e5ce6e"`);
        await queryRunner.query(`DROP TABLE "customer_accounts"`);
    }

}
