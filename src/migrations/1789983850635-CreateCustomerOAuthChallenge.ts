import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateCustomerOAuthChallenge1789983850635 implements MigrationInterface {
    name = 'CreateCustomerOAuthChallenge1789983850635'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "customer_oauth_challenges" ("tokenHash" character varying(64) NOT NULL, "customerAccountId" uuid NOT NULL, "secretFingerprint" character varying(64) NOT NULL, "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "attempts" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_c85e3c70680e9d9654ad2a58a3b" PRIMARY KEY ("tokenHash"))`);
        await queryRunner.query(`CREATE INDEX "IDX_customer_oauth_challenges_expiry" ON "customer_oauth_challenges" ("expiresAt") `);
        await queryRunner.query(`ALTER TABLE "customer_oauth_challenges" ADD CONSTRAINT "FK_3324c06f5acada05c7172593e03" FOREIGN KEY ("customerAccountId") REFERENCES "customer_accounts"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "customer_oauth_challenges" DROP CONSTRAINT "FK_3324c06f5acada05c7172593e03"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_customer_oauth_challenges_expiry"`);
        await queryRunner.query(`DROP TABLE "customer_oauth_challenges"`);
    }

}
