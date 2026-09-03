import { MigrationInterface, QueryRunner } from "typeorm";

export class AddRefreshTokenHashed1788390987342 implements MigrationInterface {
    name = 'AddRefreshTokenHashed1788390987342'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" ADD "currentRefreshTokenHash" character varying`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "currentRefreshTokenHash"`);
    }

}
