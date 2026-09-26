import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateTwoFactorChallenge1790091329182 implements MigrationInterface {
    name = 'CreateTwoFactorChallenge1790091329182'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "staff_oauth_challenges" ("tokenHash" character varying(64) NOT NULL, "userId" uuid NOT NULL, "secretFingerprint" character varying(64) NOT NULL, "expiresAt" TIMESTAMP WITH TIME ZONE NOT NULL, "attempts" integer NOT NULL DEFAULT '0', CONSTRAINT "PK_56e0183ebffb29e3af0480762ce" PRIMARY KEY ("tokenHash"))`);
        await queryRunner.query(`CREATE INDEX "IDX_staff_oauth_challenges_expiry" ON "staff_oauth_challenges" ("expiresAt") `);
        await queryRunner.query(`ALTER TABLE "staff_oauth_challenges" ADD CONSTRAINT "FK_84c35d6943147d8b8f8eeb72ec5" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "staff_oauth_challenges" DROP CONSTRAINT "FK_84c35d6943147d8b8f8eeb72ec5"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_staff_oauth_challenges_expiry"`);
        await queryRunner.query(`DROP TABLE "staff_oauth_challenges"`);
    }

}
