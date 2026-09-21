import { MigrationInterface, QueryRunner } from "typeorm";

export class AddProductImageUrl1789563888242 implements MigrationInterface {
    name = 'AddProductImageUrl1789563888242'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "products" ADD "imageUrl" text`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "products" DROP COLUMN "imageUrl"`);
    }

}
