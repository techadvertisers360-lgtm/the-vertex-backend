-- AlterTable
ALTER TABLE `invoice_lines` ADD COLUMN `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    ADD COLUMN `discountPercentBp` INTEGER NULL,
    ADD COLUMN `reason` TEXT NULL,
    ADD COLUMN `reversesLineId` VARCHAR(191) NULL,
    ADD COLUMN `stockItemId` VARCHAR(191) NULL;

-- AlterTable
ALTER TABLE `stock_items` ADD COLUMN `kind` ENUM('PROCEDURE', 'PHARMACY') NOT NULL DEFAULT 'PROCEDURE',
    ADD COLUMN `salePricePaisa` BIGINT NULL;

-- AlterTable
ALTER TABLE `stock_transactions` ADD COLUMN `invoiceLineId` VARCHAR(191) NULL,
    MODIFY `type` ENUM('PURCHASE', 'USAGE', 'RETURN_TO_SUPPLIER', 'DAMAGE', 'ADJUSTMENT', 'STOCK_IN', 'SALE') NOT NULL;

-- CreateIndex
CREATE UNIQUE INDEX `invoice_lines_reversesLineId_key` ON `invoice_lines`(`reversesLineId`);

-- CreateIndex
CREATE INDEX `stock_transactions_invoiceLineId_idx` ON `stock_transactions`(`invoiceLineId`);

