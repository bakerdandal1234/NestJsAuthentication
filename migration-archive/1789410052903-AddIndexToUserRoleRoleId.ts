import { MigrationInterface, QueryRunner } from "typeorm";

export class AddIndexToUserRoleRoleId1789410052903 implements MigrationInterface {
    name = 'AddIndexToUserRoleRoleId1789410052903'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE INDEX "IDX_b23c65e50a758245a33ee35fda" ON "user_roles" ("role_id") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_b23c65e50a758245a33ee35fda"`);
    }

}
