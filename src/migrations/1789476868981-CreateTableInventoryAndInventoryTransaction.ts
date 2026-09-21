import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateTableInventoryAndInventoryTransaction1789476868981 implements MigrationInterface {
    name = 'CreateTableInventoryAndInventoryTransaction1789476868981'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."inventory_transactions_type_enum" AS ENUM('PURCHASE', 'SALE', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT')`);
        await queryRunner.query(`CREATE TABLE "inventory_transactions" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "inventoryId" uuid NOT NULL, "type" "public"."inventory_transactions_type_enum" NOT NULL, "quantity" integer NOT NULL, "reason" text, "referenceId" uuid, "createdByUserId" uuid NOT NULL, "createdAt" TIMESTAMP NOT NULL DEFAULT now(), CONSTRAINT "CHK_inventory_transactions_quantity_positive" CHECK ("quantity" > 0), CONSTRAINT "PK_9b7144851f08f9eededde7edd42" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_inventory_transactions_inventory_created_at" ON "inventory_transactions" ("inventoryId", "createdAt") `);
        await queryRunner.query(`CREATE TABLE "inventory" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "productId" uuid NOT NULL, "quantity" integer NOT NULL, "minimumStock" integer NOT NULL DEFAULT '0', "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "REL_c8622e1e24c6d054d36e882449" UNIQUE ("productId"), CONSTRAINT "CHK_inventory_minimum_stock_non_negative" CHECK ("minimumStock" >= 0), CONSTRAINT "CHK_inventory_quantity_non_negative" CHECK ("quantity" >= 0), CONSTRAINT "PK_82aa5da437c5bbfb80703b08309" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_c8622e1e24c6d054d36e882449" ON "inventory" ("productId") `);
        await queryRunner.query(`ALTER TABLE "inventory_transactions" ADD CONSTRAINT "FK_f306c4cf8c2a4cd3d5653ba974e" FOREIGN KEY ("inventoryId") REFERENCES "inventory"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "inventory_transactions" ADD CONSTRAINT "FK_05ae66836bda06ca1048e696d01" FOREIGN KEY ("createdByUserId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "inventory" ADD CONSTRAINT "FK_c8622e1e24c6d054d36e8824490" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "inventory" DROP CONSTRAINT "FK_c8622e1e24c6d054d36e8824490"`);
        await queryRunner.query(`ALTER TABLE "inventory_transactions" DROP CONSTRAINT "FK_05ae66836bda06ca1048e696d01"`);
        await queryRunner.query(`ALTER TABLE "inventory_transactions" DROP CONSTRAINT "FK_f306c4cf8c2a4cd3d5653ba974e"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_c8622e1e24c6d054d36e882449"`);
        await queryRunner.query(`DROP TABLE "inventory"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_inventory_transactions_inventory_created_at"`);
        await queryRunner.query(`DROP TABLE "inventory_transactions"`);
        await queryRunner.query(`DROP TYPE "public"."inventory_transactions_type_enum"`);
    }

}
