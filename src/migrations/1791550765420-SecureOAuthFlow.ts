import { MigrationInterface, QueryRunner } from "typeorm";

export class SecureOAuthFlow1791550765420 implements MigrationInterface {
    name = 'SecureOAuthFlow1791550765420'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "oauth_states" ("stateHash" character varying(64) NOT NULL, "browserTokenHash" character varying(64) NOT NULL, "provider" character varying(10) NOT NULL, "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, CONSTRAINT "PK_oauth_states" PRIMARY KEY ("stateHash"))`);
        await queryRunner.query(`CREATE INDEX "IDX_oauth_states_expiry" ON "oauth_states" ("expiresAt") `);
        await queryRunner.query(`ALTER TABLE "sessions" ADD "oauthExchangeCodeHash" character varying(64)`);
        await queryRunner.query(`ALTER TABLE "sessions" ADD "oauthExchangeCodeExpiresAt" TIMESTAMP WITH TIME ZONE`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN "oauthExchangeCodeExpiresAt"`);
        await queryRunner.query(`ALTER TABLE "sessions" DROP COLUMN "oauthExchangeCodeHash"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_oauth_states_expiry"`);
        await queryRunner.query(`DROP TABLE "oauth_states"`);
    }

}
