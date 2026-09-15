import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateCustomerTable1789469611551 implements MigrationInterface {
    name = 'CreateCustomerTable1789469611551'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "customers" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "firstName" character varying NOT NULL, "lastName" character varying NOT NULL, "email" character varying, "phone" character varying, "addressLine1" character varying NOT NULL, "addressLine2" character varying, "city" character varying NOT NULL, "state" character varying, "postalCode" character varying, "country" character varying NOT NULL, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_133ec679a801fab5e070f73d3ea" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_8536b8b85c06969f84f0c098b0" ON "customers" ("email") `);
        await queryRunner.query(`CREATE INDEX "IDX_2cf358083303634803f1dfb763" ON "customers" ("createdAt") `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "public"."IDX_2cf358083303634803f1dfb763"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_8536b8b85c06969f84f0c098b0"`);
        await queryRunner.query(`DROP TABLE "customers"`);
    }

}
