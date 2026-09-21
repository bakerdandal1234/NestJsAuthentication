import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateStaffOAuthChallenges1789963698901 implements MigrationInterface {
    name = 'CreateStaffOAuthChallenges1789963698901'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "staff_oauth_challenges" DROP CONSTRAINT "staff_oauth_challenges_userId_fkey"`);
        await queryRunner.query(`ALTER TABLE "staff_oauth_challenges" ADD CONSTRAINT "FK_84c35d6943147d8b8f8eeb72ec5" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "staff_oauth_challenges" DROP CONSTRAINT "FK_84c35d6943147d8b8f8eeb72ec5"`);
        await queryRunner.query(`ALTER TABLE "staff_oauth_challenges" ADD CONSTRAINT "staff_oauth_challenges_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

}
