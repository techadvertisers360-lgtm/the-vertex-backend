-- Invoice module, step 1 (D-084). Adds to the existing billing tables; no existing money value is changed.

-- ───────── Existing tables: new columns ─────────
ALTER TABLE `invoice_lines` ADD COLUMN `serviceId` VARCHAR(191) NULL;

-- invoiceDate starts nullable so existing rows can be filled in below.
ALTER TABLE `invoices` ADD COLUMN `cancelMoney` ENUM('NONE', 'MOVED_TO_ADVANCE', 'REFUNDED') NULL,
    ADD COLUMN `cancelReason` TEXT NULL,
    ADD COLUMN `cancelledAt` DATETIME(3) NULL,
    ADD COLUMN `cancelledById` VARCHAR(191) NULL,
    ADD COLUMN `doctorId` VARCHAR(191) NULL,
    ADD COLUMN `idempotencyKey` VARCHAR(191) NULL,
    ADD COLUMN `invoiceDate` DATE NULL,
    ADD COLUMN `taxPaisa` BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN `taxRateBp` INTEGER NULL,
    MODIFY `kind` ENUM('VISIT', 'COUNTER', 'DIRECT') NOT NULL DEFAULT 'VISIT';

ALTER TABLE `ledger_entries` MODIFY `account` ENUM('CASH_IN_HAND', 'BANK', 'SUPPLIER_PAYABLE', 'PATIENT_RECEIVABLE', 'PATIENT_ADVANCE') NOT NULL;

ALTER TABLE `payments` ADD COLUMN `note` TEXT NULL,
    ADD COLUMN `paymentModeId` VARCHAR(191) NULL,
    ADD COLUMN `reversesPaymentId` VARCHAR(191) NULL,
    MODIFY `method` ENUM('CASH', 'CARD', 'BANK_ONLINE', 'CHEQUE', 'ADVANCE') NOT NULL;

ALTER TABLE `services` ADD COLUMN `invoiceCategoryId` VARCHAR(191) NULL;

ALTER TABLE `supplier_payments` MODIFY `method` ENUM('CASH', 'CARD', 'BANK_ONLINE', 'CHEQUE', 'ADVANCE') NOT NULL;

-- ───────── New tables ─────────
CREATE TABLE `payment_modes` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `method` ENUM('CASH', 'CARD', 'BANK_ONLINE', 'CHEQUE', 'ADVANCE') NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `payment_modes_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `invoice_categories` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `invoice_categories_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `patient_advance_entries` (
    `id` VARCHAR(191) NOT NULL,
    `patientId` VARCHAR(191) NOT NULL,
    `type` ENUM('RECEIPT', 'APPLIED', 'CANCEL_CREDIT', 'REFUND') NOT NULL,
    `amountPaisa` BIGINT NOT NULL,
    `receiptNo` VARCHAR(191) NULL,
    `method` ENUM('CASH', 'CARD', 'BANK_ONLINE', 'CHEQUE', 'ADVANCE') NULL,
    `paymentModeId` VARCHAR(191) NULL,
    `reference` VARCHAR(191) NULL,
    `bankAccountId` VARCHAR(191) NULL,
    `invoiceId` VARCHAR(191) NULL,
    `paymentId` VARCHAR(191) NULL,
    `note` TEXT NULL,
    `actorId` VARCHAR(191) NOT NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `patient_advance_entries_receiptNo_key`(`receiptNo`),
    UNIQUE INDEX `patient_advance_entries_idempotencyKey_key`(`idempotencyKey`),
    INDEX `patient_advance_entries_patientId_createdAt_idx`(`patientId`, `createdAt`),
    INDEX `patient_advance_entries_createdAt_idx`(`createdAt`),
    INDEX `patient_advance_entries_invoiceId_idx`(`invoiceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- ───────── Fill existing rows ─────────
-- Asia/Karachi is a fixed UTC+5 with no daylight saving; an offset avoids needing MySQL's time zone tables.
UPDATE `invoices` SET `invoiceDate` = DATE(DATE_ADD(`createdAt`, INTERVAL 5 HOUR));
-- The default lets backend code from before this column keep creating invoices between this migration and the deploy.
ALTER TABLE `invoices` MODIFY `invoiceDate` DATE NOT NULL DEFAULT (cast((utc_timestamp() + interval 5 hour) as date));

UPDATE `invoices` i INNER JOIN `appointments` a ON a.`id` = i.`appointmentId` SET i.`doctorId` = a.`doctorId`;

-- The four existing payment types become the first modes. Existing payments keep paymentModeId NULL because the
-- payments table is append-only; screens show their `method` instead.
INSERT INTO `payment_modes` (`id`, `name`, `method`, `sortOrder`, `updatedAt`) VALUES
    ('pm_cash', 'Cash', 'CASH', 1, CURRENT_TIMESTAMP(3)),
    ('pm_card', 'Card', 'CARD', 2, CURRENT_TIMESTAMP(3)),
    ('pm_online', 'Online Transfer', 'BANK_ONLINE', 3, CURRENT_TIMESTAMP(3)),
    ('pm_cheque', 'Cheque', 'CHEQUE', 4, CURRENT_TIMESTAMP(3));

INSERT INTO `invoice_categories` (`id`, `name`, `sortOrder`, `updatedAt`) VALUES
    ('ic_consultation', 'Consultation', 1, CURRENT_TIMESTAMP(3)),
    ('ic_procedure', 'Procedure', 2, CURRENT_TIMESTAMP(3)),
    ('ic_injection', 'Injection', 3, CURRENT_TIMESTAMP(3));

-- Categories already typed on services become managed categories (matching ignores case, like the unique index).
INSERT IGNORE INTO `invoice_categories` (`id`, `name`, `sortOrder`, `updatedAt`)
SELECT CONCAT('ic_', REPLACE(UUID(), '-', '')), x.`c`, 100, CURRENT_TIMESTAMP(3)
FROM (SELECT DISTINCT TRIM(`category`) AS `c` FROM `services` WHERE `category` IS NOT NULL AND TRIM(`category`) <> '') x;

UPDATE `services` s INNER JOIN `invoice_categories` c ON c.`name` = TRIM(s.`category`) SET s.`invoiceCategoryId` = c.`id`;
UPDATE `services` SET `invoiceCategoryId` = 'ic_consultation' WHERE `invoiceCategoryId` IS NULL AND `type` = 'CONSULTATION';
UPDATE `services` SET `invoiceCategoryId` = 'ic_procedure' WHERE `invoiceCategoryId` IS NULL AND `type` = 'PROCEDURE';

-- ───────── Indexes and foreign keys ─────────
CREATE UNIQUE INDEX `invoices_idempotencyKey_key` ON `invoices`(`idempotencyKey`);
CREATE INDEX `invoices_invoiceDate_idx` ON `invoices`(`invoiceDate`);
CREATE INDEX `invoices_patientId_invoiceDate_idx` ON `invoices`(`patientId`, `invoiceDate`);
CREATE INDEX `invoices_doctorId_invoiceDate_idx` ON `invoices`(`doctorId`, `invoiceDate`);
CREATE INDEX `patients_name_idx` ON `patients`(`name`);
CREATE UNIQUE INDEX `payments_reversesPaymentId_key` ON `payments`(`reversesPaymentId`);
CREATE INDEX `payments_paymentModeId_idx` ON `payments`(`paymentModeId`);
CREATE INDEX `services_invoiceCategoryId_idx` ON `services`(`invoiceCategoryId`);

ALTER TABLE `services` ADD CONSTRAINT `services_invoiceCategoryId_fkey` FOREIGN KEY (`invoiceCategoryId`) REFERENCES `invoice_categories`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_patientId_fkey` FOREIGN KEY (`patientId`) REFERENCES `patients`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `invoices` ADD CONSTRAINT `invoices_doctorId_fkey` FOREIGN KEY (`doctorId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `payments` ADD CONSTRAINT `payments_paymentModeId_fkey` FOREIGN KEY (`paymentModeId`) REFERENCES `payment_modes`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE `patient_advance_entries` ADD CONSTRAINT `patient_advance_entries_patientId_fkey` FOREIGN KEY (`patientId`) REFERENCES `patients`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `payments` RENAME INDEX `payments_invoiceId_fkey` TO `payments_invoiceId_idx`;

-- ───────── Never changed or deleted (spec §4.9) ─────────
CREATE TRIGGER `patient_advance_entries_no_update` BEFORE UPDATE ON `patient_advance_entries` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'patient_advance_entries is append-only';
CREATE TRIGGER `patient_advance_entries_no_delete` BEFORE DELETE ON `patient_advance_entries` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'patient_advance_entries is append-only';
CREATE TRIGGER `payment_modes_no_delete` BEFORE DELETE ON `payment_modes` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'payment_modes rows cannot be deleted';
CREATE TRIGGER `invoice_categories_no_delete` BEFORE DELETE ON `invoice_categories` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'invoice_categories rows cannot be deleted';
