-- AlterTable
ALTER TABLE `attachments` MODIFY `route` ENUM('consentForm', 'prescriptionPhoto', 'beforePhoto', 'afterPhoto', 'itemsUsedEvidence', 'roomCleanPhoto', 'roomChecklistPhoto', 'machineIssuePhoto', 'damagePhoto', 'adCreative', 'requestAttachment', 'complaintAttachment', 'vendorInvoice', 'labReport', 'officeBill') NOT NULL;

-- AlterTable
ALTER TABLE `doctor_profiles` ADD COLUMN `departments` JSON NULL;

-- AlterTable
ALTER TABLE `feedback` ADD COLUMN `managerRating` INTEGER NULL,
    ADD COLUMN `receptionRating` INTEGER NULL;

-- AlterTable
ALTER TABLE `procedure_tasks` ADD COLUMN `mediaConsent` BOOLEAN NULL;

-- AlterTable
ALTER TABLE `room_reservations` ADD COLUMN `purpose` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `services` ADD COLUMN `department` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `stock_items` ADD COLUMN `floorPricePaisa` BIGINT NULL;

-- CreateTable
CREATE TABLE `invoice_requests` (
    `id` VARCHAR(191) NOT NULL,
    `type` ENUM('PART_PAYMENT', 'BILL_CORRECTION') NOT NULL,
    `invoiceId` VARCHAR(191) NOT NULL,
    `requestedById` VARCHAR(191) NOT NULL,
    `amountNeededPaisa` BIGINT NULL,
    `amountAskedPaisa` BIGINT NULL,
    `amountApprovedPaisa` BIGINT NULL,
    `adjustmentPaisa` BIGINT NULL,
    `note` TEXT NOT NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `decidedById` VARCHAR(191) NULL,
    `decisionNote` TEXT NULL,
    `decidedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `invoice_requests_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `invoice_requests_invoiceId_idx`(`invoiceId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cash_handovers` (
    `id` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `amountPaisa` BIGINT NOT NULL,
    `leftAtDeskPaisa` BIGINT NULL,
    `fromId` VARCHAR(191) NOT NULL,
    `toId` VARCHAR(191) NOT NULL,
    `note` TEXT NULL,
    `receivedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `cash_handovers_date_idx`(`date`),
    INDEX `cash_handovers_toId_receivedAt_idx`(`toId`, `receivedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sale_returns` (
    `id` VARCHAR(191) NOT NULL,
    `number` VARCHAR(191) NOT NULL,
    `invoiceId` VARCHAR(191) NOT NULL,
    `invoiceLineId` VARCHAR(191) NOT NULL,
    `quantity` INTEGER NOT NULL,
    `restock` BOOLEAN NOT NULL,
    `refundPaisa` BIGINT NOT NULL,
    `method` ENUM('CASH', 'CARD', 'BANK_ONLINE', 'CHEQUE', 'ADVANCE') NOT NULL,
    `bankAccountId` VARCHAR(191) NULL,
    `reference` VARCHAR(191) NULL,
    `reason` TEXT NOT NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `requestedById` VARCHAR(191) NOT NULL,
    `decidedById` VARCHAR(191) NULL,
    `decisionNote` TEXT NULL,
    `decidedAt` DATETIME(3) NULL,
    `paymentId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `sale_returns_number_key`(`number`),
    INDEX `sale_returns_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `sale_returns_invoiceLineId_idx`(`invoiceLineId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `doctor_share_rules` (
    `doctorId` VARCHAR(191) NOT NULL,
    `ownConsultBp` INTEGER NOT NULL DEFAULT 0,
    `ownProcedureBp` INTEGER NOT NULL DEFAULT 0,
    `clinicConsultBp` INTEGER NOT NULL DEFAULT 0,
    `clinicProcedureBp` INTEGER NOT NULL DEFAULT 0,
    `fixedCostPaisa` BIGINT NOT NULL DEFAULT 0,
    `updatedById` VARCHAR(191) NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`doctorId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `doctor_own_patients` (
    `id` VARCHAR(191) NOT NULL,
    `doctorId` VARCHAR(191) NOT NULL,
    `patientId` VARCHAR(191) NOT NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `doctor_own_patients_doctorId_patientId_key`(`doctorId`, `patientId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `doctor_payouts` (
    `id` VARCHAR(191) NOT NULL,
    `doctorId` VARCHAR(191) NOT NULL,
    `amountPaisa` BIGINT NOT NULL,
    `method` VARCHAR(191) NOT NULL,
    `reference` VARCHAR(191) NULL,
    `note` TEXT NULL,
    `paidById` VARCHAR(191) NOT NULL,
    `paidAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `doctor_payouts_doctorId_paidAt_idx`(`doctorId`, `paidAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `expenses` (
    `id` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `category` VARCHAR(191) NOT NULL,
    `description` VARCHAR(191) NOT NULL,
    `amountPaisa` BIGINT NOT NULL,
    `paidFrom` ENUM('OWNER', 'RECEPTION_DRAWER', 'MANAGER', 'BANK') NOT NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `expenses_date_idx`(`date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `staff_profiles` (
    `userId` VARCHAR(191) NOT NULL,
    `salaryPaisa` BIGINT NOT NULL DEFAULT 0,
    `workingDays` INTEGER NOT NULL DEFAULT 24,
    `startDate` DATE NULL,
    `emergencyContact` VARCHAR(191) NULL,
    `personalEmail` VARCHAR(191) NULL,
    `updatedById` VARCHAR(191) NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`userId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `staff_marks` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `month` VARCHAR(7) NOT NULL,
    `kind` ENUM('ABSENCE', 'LATE', 'UNIFORM', 'WARNING', 'POINTS') NOT NULL,
    `points` INTEGER NULL,
    `note` TEXT NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `staff_marks_userId_month_idx`(`userId`, `month`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `salary_advances` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `amountPaisa` BIGINT NOT NULL,
    `note` TEXT NULL,
    `slipId` VARCHAR(191) NULL,
    `actorId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `salary_advances_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `salary_slips` (
    `id` VARCHAR(191) NOT NULL,
    `number` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `month` VARCHAR(7) NOT NULL,
    `salaryPaisa` BIGINT NOT NULL,
    `extraAbsences` INTEGER NOT NULL,
    `absenceDeductionPaisa` BIGINT NOT NULL,
    `advanceCutPaisa` BIGINT NOT NULL,
    `bonusPaisa` BIGINT NOT NULL DEFAULT 0,
    `netPaisa` BIGINT NOT NULL,
    `paidById` VARCHAR(191) NOT NULL,
    `paidAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `salary_slips_number_key`(`number`),
    UNIQUE INDEX `salary_slips_userId_month_key`(`userId`, `month`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `package_types` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `kind` ENUM('PACKAGE', 'MEMBERSHIP') NOT NULL DEFAULT 'PACKAGE',
    `sessions` INTEGER NOT NULL,
    `pricePaisa` BIGINT NOT NULL,
    `validDays` INTEGER NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `package_types_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `package_sales` (
    `id` VARCHAR(191) NOT NULL,
    `number` VARCHAR(191) NOT NULL,
    `typeId` VARCHAR(191) NOT NULL,
    `patientId` VARCHAR(191) NOT NULL,
    `invoiceId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `sessions` INTEGER NOT NULL,
    `pricePaisa` BIGINT NOT NULL,
    `expiresAt` DATETIME(3) NULL,
    `soldById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `package_sales_number_key`(`number`),
    UNIQUE INDEX `package_sales_invoiceId_key`(`invoiceId`),
    INDEX `package_sales_patientId_idx`(`patientId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `package_session_uses` (
    `id` VARCHAR(191) NOT NULL,
    `saleId` VARCHAR(191) NOT NULL,
    `usedById` VARCHAR(191) NOT NULL,
    `note` TEXT NULL,
    `usedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `package_session_uses_saleId_idx`(`saleId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `purchase_orders` (
    `id` VARCHAR(191) NOT NULL,
    `number` VARCHAR(191) NOT NULL,
    `vendorId` VARCHAR(191) NOT NULL,
    `status` ENUM('OPEN', 'RECEIVED', 'CANCELLED') NOT NULL DEFAULT 'OPEN',
    `vendorBillNo` VARCHAR(191) NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `decidedById` VARCHAR(191) NULL,
    `decidedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `purchase_orders_number_key`(`number`),
    INDEX `purchase_orders_status_createdAt_idx`(`status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `purchase_order_lines` (
    `id` VARCHAR(191) NOT NULL,
    `orderId` VARCHAR(191) NOT NULL,
    `itemId` VARCHAR(191) NULL,
    `name` VARCHAR(191) NOT NULL,
    `quantity` INTEGER NOT NULL,
    `receivedQty` INTEGER NULL,

    INDEX `purchase_order_lines_orderId_idx`(`orderId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `office_purchases` (
    `id` VARCHAR(191) NOT NULL,
    `requestedById` VARCHAR(191) NOT NULL,
    `items` JSON NOT NULL,
    `estimatePaisa` BIGINT NOT NULL,
    `status` ENUM('PENDING', 'WITH_OWNERS', 'CASH_GIVEN', 'SETTLED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `budgetPaisa` BIGINT NULL,
    `cashFrom` ENUM('OWNER', 'RECEPTION_DRAWER', 'MANAGER', 'BANK') NULL,
    `decidedById` VARCHAR(191) NULL,
    `decidedAt` DATETIME(3) NULL,
    `decisionNote` TEXT NULL,
    `billTotalPaisa` BIGINT NULL,
    `changePaisa` BIGINT NULL,
    `billAttachmentId` VARCHAR(191) NULL,
    `settledById` VARCHAR(191) NULL,
    `settledAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `office_purchases_status_createdAt_idx`(`status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `chat_messages` (
    `id` VARCHAR(191) NOT NULL,
    `room` VARCHAR(40) NOT NULL,
    `senderId` VARCHAR(191) NOT NULL,
    `body` TEXT NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `chat_messages_room_createdAt_idx`(`room`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `saved_reports` (
    `id` VARCHAR(191) NOT NULL,
    `kind` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `payload` JSON NOT NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `saved_reports_kind_date_idx`(`kind`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `vendor_payment_requests` (
    `id` VARCHAR(191) NOT NULL,
    `vendorId` VARCHAR(191) NOT NULL,
    `amountPaisa` BIGINT NOT NULL,
    `note` TEXT NOT NULL,
    `status` ENUM('PENDING', 'APPROVED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `requestedById` VARCHAR(191) NOT NULL,
    `decidedById` VARCHAR(191) NULL,
    `decisionNote` TEXT NULL,
    `decidedAt` DATETIME(3) NULL,
    `supplierPaymentId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `vendor_payment_requests_status_createdAt_idx`(`status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `service_kit_items` (
    `id` VARCHAR(191) NOT NULL,
    `serviceId` VARCHAR(191) NOT NULL,
    `itemId` VARCHAR(191) NOT NULL,
    `quantity` INTEGER NOT NULL,

    UNIQUE INDEX `service_kit_items_serviceId_itemId_key`(`serviceId`, `itemId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `campaign_spends` (
    `id` VARCHAR(191) NOT NULL,
    `campaign` VARCHAR(191) NOT NULL,
    `month` VARCHAR(7) NOT NULL,
    `spendPaisa` BIGINT NOT NULL,
    `updatedById` VARCHAR(191) NOT NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `campaign_spends_campaign_month_key`(`campaign`, `month`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `package_session_uses` ADD CONSTRAINT `package_session_uses_saleId_fkey` FOREIGN KEY (`saleId`) REFERENCES `package_sales`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `purchase_order_lines` ADD CONSTRAINT `purchase_order_lines_orderId_fkey` FOREIGN KEY (`orderId`) REFERENCES `purchase_orders`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TRIGGER `expenses_no_delete` BEFORE DELETE ON `expenses` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'expenses rows are never deleted';
CREATE TRIGGER `expenses_no_update` BEFORE UPDATE ON `expenses` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'expenses rows are never updated';
CREATE TRIGGER `doctor_payouts_no_delete` BEFORE DELETE ON `doctor_payouts` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'doctor_payouts rows are never deleted';
CREATE TRIGGER `doctor_payouts_no_update` BEFORE UPDATE ON `doctor_payouts` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'doctor_payouts rows are never updated';
CREATE TRIGGER `salary_slips_no_delete` BEFORE DELETE ON `salary_slips` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'salary_slips rows are never deleted';
CREATE TRIGGER `salary_slips_no_update` BEFORE UPDATE ON `salary_slips` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'salary_slips rows are never updated';
CREATE TRIGGER `salary_advances_no_delete` BEFORE DELETE ON `salary_advances` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'salary_advances rows are never deleted';
CREATE TRIGGER `salary_advances_no_update` BEFORE UPDATE ON `salary_advances` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'salary_advances rows are never updated';
CREATE TRIGGER `package_session_uses_no_delete` BEFORE DELETE ON `package_session_uses` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'package_session_uses rows are never deleted';
CREATE TRIGGER `chat_messages_no_delete` BEFORE DELETE ON `chat_messages` FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'chat_messages rows are never deleted';
