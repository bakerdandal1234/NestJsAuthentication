import { MigrationInterface, QueryRunner } from "typeorm";

export class CreateStripeWebhookEventsTable1789504882074 implements MigrationInterface {
    name = 'CreateStripeWebhookEventsTable1789504882074'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TYPE "public"."refunds_status_enum" AS ENUM('PENDING', 'SUCCESS', 'FAILED')`);
        await queryRunner.query(`CREATE TABLE "refunds" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "paymentId" uuid NOT NULL, "amount" numeric(10,2) NOT NULL, "status" "public"."refunds_status_enum" NOT NULL DEFAULT 'PENDING', "providerRefundId" character varying(255), "idempotencyKey" character varying(255) NOT NULL, "reason" character varying(500), "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), "completedAt" TIMESTAMP WITH TIME ZONE, CONSTRAINT "PK_5106efb01eeda7e49a78b869738" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_refunds_idempotency_key" ON "refunds" ("idempotencyKey") `);
        await queryRunner.query(`CREATE INDEX "IDX_refunds_payment_id" ON "refunds" ("paymentId") `);
        await queryRunner.query(`CREATE TYPE "public"."payments_method_enum" AS ENUM('CARD')`);
        await queryRunner.query(`CREATE TYPE "public"."payments_status_enum" AS ENUM('PENDING', 'SUCCESS', 'FAILED')`);
        await queryRunner.query(`CREATE TYPE "public"."payments_provider_enum" AS ENUM('STRIPE')`);
        await queryRunner.query(`CREATE TABLE "payments" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "orderId" uuid NOT NULL, "amount" numeric(10,2) NOT NULL, "method" "public"."payments_method_enum" NOT NULL, "status" "public"."payments_status_enum" NOT NULL DEFAULT 'PENDING', "provider" "public"."payments_provider_enum" NOT NULL, "providerTransactionId" character varying(255), "idempotencyKey" character varying(255) NOT NULL, "paidAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_197ab7af18c93fbb0c9b28b4a59" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_payments_idempotency_key" ON "payments" ("idempotencyKey") `);
        await queryRunner.query(`CREATE INDEX "IDX_payments_order_id" ON "payments" ("orderId") `);
        await queryRunner.query(`CREATE TABLE "stripe_webhook_events" ("id" uuid NOT NULL DEFAULT uuid_generate_v4(), "stripeEventId" character varying(255) NOT NULL, "type" character varying(255) NOT NULL, "processedAt" TIMESTAMP WITH TIME ZONE, "createdAt" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_0cf13fd3f2ff5604e092bc1ff48" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_stripe_webhook_events_stripe_event_id" ON "stripe_webhook_events" ("stripeEventId") `);
        await queryRunner.query(`ALTER TABLE "refunds" ADD CONSTRAINT "FK_a276dea330e561499e4a6e1b309" FOREIGN KEY ("paymentId") REFERENCES "payments"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "payments" ADD CONSTRAINT "FK_af929a5f2a400fdb6913b4967e1" FOREIGN KEY ("orderId") REFERENCES "orders"("id") ON DELETE RESTRICT ON UPDATE NO ACTION`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "payments" DROP CONSTRAINT "FK_af929a5f2a400fdb6913b4967e1"`);
        await queryRunner.query(`ALTER TABLE "refunds" DROP CONSTRAINT "FK_a276dea330e561499e4a6e1b309"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_stripe_webhook_events_stripe_event_id"`);
        await queryRunner.query(`DROP TABLE "stripe_webhook_events"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_payments_order_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_payments_idempotency_key"`);
        await queryRunner.query(`DROP TABLE "payments"`);
        await queryRunner.query(`DROP TYPE "public"."payments_provider_enum"`);
        await queryRunner.query(`DROP TYPE "public"."payments_status_enum"`);
        await queryRunner.query(`DROP TYPE "public"."payments_method_enum"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_refunds_payment_id"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_refunds_idempotency_key"`);
        await queryRunner.query(`DROP TABLE "refunds"`);
        await queryRunner.query(`DROP TYPE "public"."refunds_status_enum"`);
    }

}
