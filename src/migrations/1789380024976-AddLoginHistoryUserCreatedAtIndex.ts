import { MigrationInterface, QueryRunner } from "typeorm";

export class AddLoginHistoryUserCreatedAtIndex1789380024976 implements MigrationInterface {
    name = 'AddLoginHistoryUserCreatedAtIndex1789380024976'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE INDEX "idx_login_history_user_created_at" ON "login_history" ("userId", "createdAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."idx_login_history_user_created_at"`);
    }

}
