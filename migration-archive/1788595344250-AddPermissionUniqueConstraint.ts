import { MigrationInterface, QueryRunner } from "typeorm";

export class AddPermissionUniqueConstraint1788595344250 implements MigrationInterface {
    name = 'AddPermissionUniqueConstraint1788595344250'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "permissions" ADD CONSTRAINT "UQ_7331684c0c5b063803a425001a0" UNIQUE ("resource", "action")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "permissions" DROP CONSTRAINT "UQ_7331684c0c5b063803a425001a0"`);
    }

}
