import { MigrationInterface, QueryRunner } from "typeorm";

export class RemoveRefreshTokensHash1788392257564 implements MigrationInterface {
    name = 'RemoveRefreshTokensHash1788392257564'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "currentRefreshTokenHash"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" ADD "currentRefreshTokenHash" character varying`);
    }

}
