-- CreateTable
CREATE TABLE `stock_intakes` (
    `id` VARCHAR(191) NOT NULL,
    `itemId` VARCHAR(191) NOT NULL,
    `quantity` INTEGER NOT NULL,
    `pricePaisa` BIGINT NOT NULL,
    `expiryDate` DATE NULL,
    `status` ENUM('PENDING', 'VERIFIED', 'REJECTED') NOT NULL DEFAULT 'PENDING',
    `addedById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `decidedById` VARCHAR(191) NULL,
    `decidedAt` DATETIME(3) NULL,
    `reason` TEXT NULL,
    `batchId` VARCHAR(191) NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,

    UNIQUE INDEX `stock_intakes_idempotencyKey_key`(`idempotencyKey`),
    INDEX `stock_intakes_status_createdAt_idx`(`status`, `createdAt`),
    INDEX `stock_intakes_itemId_idx`(`itemId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `stock_intakes` ADD CONSTRAINT `stock_intakes_itemId_fkey` FOREIGN KEY (`itemId`) REFERENCES `stock_items`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

