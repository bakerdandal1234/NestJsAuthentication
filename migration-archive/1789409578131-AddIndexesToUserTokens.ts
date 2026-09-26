import { MigrationInterface, QueryRunner } from "typeorm";

export class AddIndexesToUserTokens1789409578131 implements MigrationInterface {
    name = 'AddIndexesToUserTokens1789409578131'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_7ad75a333a7bcf6a2b5d3517ca" ON "users" ("emailVerificationToken") `);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_bffe933a388d6bde48891ff95a" ON "users" ("passwordResetToken") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_bffe933a388d6bde48891ff95a"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_7ad75a333a7bcf6a2b5d3517ca"`);
    }

}
