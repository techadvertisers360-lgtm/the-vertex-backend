-- CreateTable
CREATE TABLE `users` (
    `id` VARCHAR(191) NOT NULL,
    `displayName` VARCHAR(191) NOT NULL,
    `email` VARCHAR(191) NULL,
    `phone` VARCHAR(191) NULL,
    `memberCode` VARCHAR(191) NULL,
    `passwordHash` VARCHAR(191) NOT NULL,
    `role` ENUM('LEAD_MEMBER', 'RECEPTIONIST', 'DOCTOR', 'ASSISTANT', 'OFFICE_BOY', 'MANAGER', 'MD', 'MARKETING_DIRECTOR', 'MARKETING_LEAD') NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `tokenVersion` INTEGER NOT NULL DEFAULT 0,
    `title` VARCHAR(191) NULL,
    `isDemo` BOOLEAN NOT NULL DEFAULT false,
    `createdById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `users_email_key`(`email`),
    UNIQUE INDEX `users_phone_key`(`phone`),
    UNIQUE INDEX `users_memberCode_key`(`memberCode`),
    INDEX `users_role_active_idx`(`role`, `active`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sessions` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `refreshTokenHash` VARCHAR(191) NOT NULL,
    `tokenVersion` INTEGER NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `revokedAt` DATETIME(3) NULL,
    `replacedById` VARCHAR(191) NULL,
    `userAgent` VARCHAR(512) NULL,
    `ip` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastUsedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `sessions_refreshTokenHash_key`(`refreshTokenHash`),
    INDEX `sessions_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `password_reset_tokens` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `tokenHash` VARCHAR(191) NOT NULL,
    `expiresAt` DATETIME(3) NOT NULL,
    `usedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `password_reset_tokens_tokenHash_key`(`tokenHash`),
    INDEX `password_reset_tokens_userId_idx`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `lead_member_profiles` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `notes` TEXT NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `lead_member_profiles_userId_key`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `doctor_profiles` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `specialty` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `doctor_profiles_userId_key`(`userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `meta_sheets` (
    `id` VARCHAR(191) NOT NULL,
    `externalId` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `campaign` VARCHAR(191) NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `meta_sheets_externalId_key`(`externalId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sheet_assignments` (
    `id` VARCHAR(191) NOT NULL,
    `sheetId` VARCHAR(191) NOT NULL,
    `memberId` VARCHAR(191) NOT NULL,
    `assignedById` VARCHAR(191) NOT NULL,
    `assignedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `unassignedAt` DATETIME(3) NULL,
    `unassignedById` VARCHAR(191) NULL,

    INDEX `sheet_assignments_memberId_unassignedAt_idx`(`memberId`, `unassignedAt`),
    INDEX `sheet_assignments_sheetId_unassignedAt_idx`(`sheetId`, `unassignedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `leads` (
    `id` VARCHAR(191) NOT NULL,
    `sheetId` VARCHAR(191) NOT NULL,
    `assignedMemberId` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `phoneRaw` VARCHAR(191) NOT NULL,
    `remarks` TEXT NULL,
    `status` ENUM('NEW', 'CONTACTED', 'FOLLOW_UP_DUE', 'BOOKED', 'NOT_INTERESTED', 'UNREACHABLE') NOT NULL DEFAULT 'NEW',
    `nextContactAt` DATETIME(3) NULL,
    `lastContactAt` DATETIME(3) NULL,
    `outcome` VARCHAR(191) NULL,
    `duplicateOfId` VARCHAR(191) NULL,
    `externalRowId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `leads_assignedMemberId_status_idx`(`assignedMemberId`, `status`),
    INDEX `leads_phone_idx`(`phone`),
    UNIQUE INDEX `leads_sheetId_externalRowId_key`(`sheetId`, `externalRowId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `lead_activities` (
    `id` VARCHAR(191) NOT NULL,
    `leadId` VARCHAR(191) NOT NULL,
    `actorId` VARCHAR(191) NOT NULL,
    `channel` ENUM('CALL', 'WHATSAPP', 'NOTE') NOT NULL,
    `result` ENUM('CONNECTED', 'NO_ANSWER', 'BUSY', 'WRONG_NUMBER', 'SWITCHED_OFF', 'MESSAGE_SENT', 'REPLIED', 'INTERESTED', 'NOT_INTERESTED', 'CALL_BACK_LATER', 'BOOKED') NULL,
    `successful` BOOLEAN NOT NULL DEFAULT false,
    `remarks` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `lead_activities_leadId_createdAt_idx`(`leadId`, `createdAt`),
    INDEX `lead_activities_actorId_createdAt_idx`(`actorId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `lead_callbacks` (
    `id` VARCHAR(191) NOT NULL,
    `leadId` VARCHAR(191) NOT NULL,
    `memberId` VARCHAR(191) NOT NULL,
    `dueAt` DATETIME(3) NOT NULL,
    `status` ENUM('PENDING', 'DUE', 'COMPLETED', 'SUPERSEDED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `remindedAt` DATETIME(3) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `lead_callbacks_status_dueAt_idx`(`status`, `dueAt`),
    INDEX `lead_callbacks_memberId_status_idx`(`memberId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `patients` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NOT NULL,
    `phoneSlot` INTEGER NOT NULL DEFAULT 0,
    `ageYears` INTEGER NULL,
    `gender` VARCHAR(191) NULL,
    `contactConsent` BOOLEAN NOT NULL DEFAULT false,
    `whatsappConsent` BOOLEAN NOT NULL DEFAULT false,
    `whatsappOptOutAt` DATETIME(3) NULL,
    `mergedIntoId` VARCHAR(191) NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `patients_phone_phoneSlot_key`(`phone`, `phoneSlot`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `rooms` (
    `id` VARCHAR(191) NOT NULL,
    `code` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `kind` ENUM('CONSULT', 'PROCEDURE') NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `sortOrder` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `rooms_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `services` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `type` ENUM('CONSULTATION', 'PROCEDURE') NOT NULL,
    `durationMin` INTEGER NULL,
    `defaultPricePaisa` BIGINT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `services_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `doctor_schedules` (
    `id` VARCHAR(191) NOT NULL,
    `doctorId` VARCHAR(191) NOT NULL,
    `weekday` INTEGER NOT NULL,
    `startMinute` INTEGER NOT NULL,
    `endMinute` INTEGER NOT NULL,
    `effectiveFrom` DATE NOT NULL,
    `effectiveTo` DATE NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `doctor_schedules_doctorId_weekday_idx`(`doctorId`, `weekday`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `doctor_availability_exceptions` (
    `id` VARCHAR(191) NOT NULL,
    `doctorId` VARCHAR(191) NOT NULL,
    `kind` ENUM('LEAVE', 'ABSENT', 'ALTERNATE_HOURS') NOT NULL,
    `date` DATE NOT NULL,
    `startMinute` INTEGER NULL,
    `endMinute` INTEGER NULL,
    `reason` TEXT NULL,
    `status` ENUM('PENDING', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'RETURNED_FOR_CORRECTION', 'IN_PROGRESS', 'RESOLVED', 'NEED_DETAILS', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `requestedById` VARCHAR(191) NOT NULL,
    `decidedById` VARCHAR(191) NULL,
    `decidedAt` DATETIME(3) NULL,
    `decisionReason` TEXT NULL,
    `impactResolvedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `doctor_availability_exceptions_doctorId_date_status_idx`(`doctorId`, `date`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `appointments` (
    `id` VARCHAR(191) NOT NULL,
    `patientId` VARCHAR(191) NOT NULL,
    `doctorId` VARCHAR(191) NOT NULL,
    `type` ENUM('CONSULTATION', 'PROCEDURE') NOT NULL,
    `serviceId` VARCHAR(191) NULL,
    `reason` TEXT NULL,
    `startAt` DATETIME(3) NOT NULL,
    `endAt` DATETIME(3) NOT NULL,
    `roomId` VARCHAR(191) NULL,
    `status` ENUM('DRAFT', 'CONFIRMED', 'CHECKED_IN', 'WAITING', 'WITH_DOCTOR', 'RECEPTION', 'PROCEDURE', 'DONE', 'CANCELLED', 'RESCHEDULED') NOT NULL DEFAULT 'CONFIRMED',
    `source` ENUM('LEAD', 'RECEPTION', 'MANAGER', 'DOCTOR_PLAN') NOT NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `leadId` VARCHAR(191) NULL,
    `leadMemberId` VARCHAR(191) NULL,
    `sheetId` VARCHAR(191) NULL,
    `treatmentPlanItemId` VARCHAR(191) NULL,
    `rescheduledFromId` VARCHAR(191) NULL,
    `cancelledAt` DATETIME(3) NULL,
    `cancelledById` VARCHAR(191) NULL,
    `cancelReason` TEXT NULL,
    `checkedInAt` DATETIME(3) NULL,
    `checkedInById` VARCHAR(191) NULL,
    `acceptedAt` DATETIME(3) NULL,
    `sentToReceptionAt` DATETIME(3) NULL,
    `doneAt` DATETIME(3) NULL,
    `hiddenFromQueueAt` DATETIME(3) NULL,
    `idempotencyKey` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `appointments_treatmentPlanItemId_key`(`treatmentPlanItemId`),
    UNIQUE INDEX `appointments_rescheduledFromId_key`(`rescheduledFromId`),
    UNIQUE INDEX `appointments_idempotencyKey_key`(`idempotencyKey`),
    INDEX `appointments_doctorId_startAt_idx`(`doctorId`, `startAt`),
    INDEX `appointments_roomId_startAt_idx`(`roomId`, `startAt`),
    INDEX `appointments_status_startAt_idx`(`status`, `startAt`),
    INDEX `appointments_leadMemberId_startAt_idx`(`leadMemberId`, `startAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `appointment_status_history` (
    `id` VARCHAR(191) NOT NULL,
    `appointmentId` VARCHAR(191) NOT NULL,
    `fromStatus` ENUM('DRAFT', 'CONFIRMED', 'CHECKED_IN', 'WAITING', 'WITH_DOCTOR', 'RECEPTION', 'PROCEDURE', 'DONE', 'CANCELLED', 'RESCHEDULED') NULL,
    `toStatus` ENUM('DRAFT', 'CONFIRMED', 'CHECKED_IN', 'WAITING', 'WITH_DOCTOR', 'RECEPTION', 'PROCEDURE', 'DONE', 'CANCELLED', 'RESCHEDULED') NOT NULL,
    `actorId` VARCHAR(191) NULL,
    `reason` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `appointment_status_history_appointmentId_createdAt_idx`(`appointmentId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `reschedule_requests` (
    `id` VARCHAR(191) NOT NULL,
    `appointmentId` VARCHAR(191) NOT NULL,
    `requestedById` VARCHAR(191) NOT NULL,
    `requestedStartAt` DATETIME(3) NULL,
    `reason` TEXT NOT NULL,
    `status` ENUM('PENDING', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'RETURNED_FOR_CORRECTION', 'IN_PROGRESS', 'RESOLVED', 'NEED_DETAILS', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `patientConfirmed` BOOLEAN NOT NULL DEFAULT false,
    `doctorConfirmed` BOOLEAN NOT NULL DEFAULT false,
    `decidedById` VARCHAR(191) NULL,
    `decidedAt` DATETIME(3) NULL,
    `decisionReason` TEXT NULL,
    `newAppointmentId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `reschedule_requests_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `reschedule_history` (
    `id` VARCHAR(191) NOT NULL,
    `oldAppointmentId` VARCHAR(191) NOT NULL,
    `newAppointmentId` VARCHAR(191) NOT NULL,
    `oldStartAt` DATETIME(3) NOT NULL,
    `newStartAt` DATETIME(3) NOT NULL,
    `oldRoomId` VARCHAR(191) NULL,
    `newRoomId` VARCHAR(191) NULL,
    `requestedById` VARCHAR(191) NOT NULL,
    `approvedById` VARCHAR(191) NULL,
    `reason` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `reschedule_history_oldAppointmentId_idx`(`oldAppointmentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `room_reservations` (
    `id` VARCHAR(191) NOT NULL,
    `roomId` VARCHAR(191) NOT NULL,
    `appointmentId` VARCHAR(191) NULL,
    `procedureTaskId` VARCHAR(191) NULL,
    `startAt` DATETIME(3) NOT NULL,
    `endAt` DATETIME(3) NOT NULL,
    `status` ENUM('ACTIVE', 'AWAITING_CLEAN', 'RELEASED', 'CANCELLED') NOT NULL DEFAULT 'ACTIVE',
    `releasedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `room_reservations_roomId_status_startAt_idx`(`roomId`, `status`, `startAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `vitals` (
    `id` VARCHAR(191) NOT NULL,
    `appointmentId` VARCHAR(191) NOT NULL,
    `bpSystolic` INTEGER NULL,
    `bpDiastolic` INTEGER NULL,
    `glucoseMgDl` INTEGER NULL,
    `weightGrams` INTEGER NULL,
    `heightMm` INTEGER NULL,
    `skipped` BOOLEAN NOT NULL DEFAULT false,
    `skipReason` VARCHAR(191) NULL,
    `enteredById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `vitals_appointmentId_idx`(`appointmentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `treatment_plans` (
    `id` VARCHAR(191) NOT NULL,
    `patientId` VARCHAR(191) NOT NULL,
    `doctorId` VARCHAR(191) NOT NULL,
    `appointmentId` VARCHAR(191) NOT NULL,
    `currentVersionNo` INTEGER NOT NULL DEFAULT 0,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `treatment_plans_appointmentId_key`(`appointmentId`),
    INDEX `treatment_plans_patientId_idx`(`patientId`),
    INDEX `treatment_plans_doctorId_idx`(`doctorId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `treatment_plan_versions` (
    `id` VARCHAR(191) NOT NULL,
    `planId` VARCHAR(191) NOT NULL,
    `versionNo` INTEGER NOT NULL,
    `consultationReason` TEXT NOT NULL,
    `consultationFeePaisa` BIGINT NOT NULL,
    `consultationFeeWaived` BOOLEAN NOT NULL DEFAULT false,
    `consultationDiscountPaisa` BIGINT NOT NULL DEFAULT 0,
    `itemsSubtotalPaisa` BIGINT NOT NULL,
    `itemsDiscountPaisa` BIGINT NOT NULL,
    `totalDiscountPaisa` BIGINT NOT NULL,
    `grandTotalPaisa` BIGINT NOT NULL,
    `advanceRequestedPaisa` BIGINT NOT NULL,
    `balancePaisa` BIGINT NOT NULL,
    `installmentCount` INTEGER NOT NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `treatment_plan_versions_planId_versionNo_key`(`planId`, `versionNo`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `treatment_plan_items` (
    `id` VARCHAR(191) NOT NULL,
    `versionId` VARCHAR(191) NOT NULL,
    `sessionNumber` INTEGER NOT NULL,
    `serviceId` VARCHAR(191) NULL,
    `procedureName` VARCHAR(191) NOT NULL,
    `sameDay` BOOLEAN NOT NULL,
    `scheduledStart` DATETIME(3) NOT NULL,
    `scheduledEnd` DATETIME(3) NOT NULL,
    `roomId` VARCHAR(191) NULL,
    `pricePaisa` BIGINT NOT NULL,
    `discountPaisa` BIGINT NOT NULL DEFAULT 0,
    `status` ENUM('PLANNED', 'SCHEDULED', 'IN_PROGRESS', 'DONE', 'CANCELLED', 'SUPERSEDED') NOT NULL DEFAULT 'PLANNED',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `treatment_plan_items_status_scheduledStart_idx`(`status`, `scheduledStart`),
    UNIQUE INDEX `treatment_plan_items_versionId_sessionNumber_key`(`versionId`, `sessionNumber`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `installments` (
    `id` VARCHAR(191) NOT NULL,
    `versionId` VARCHAR(191) NOT NULL,
    `seq` INTEGER NOT NULL,
    `dueDate` DATE NOT NULL,
    `amountPaisa` BIGINT NOT NULL,

    UNIQUE INDEX `installments_versionId_seq_key`(`versionId`, `seq`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `invoices` (
    `id` VARCHAR(191) NOT NULL,
    `number` VARCHAR(191) NOT NULL,
    `patientId` VARCHAR(191) NOT NULL,
    `appointmentId` VARCHAR(191) NOT NULL,
    `planVersionId` VARCHAR(191) NULL,
    `status` ENUM('OPEN', 'CLOSED', 'VOID') NOT NULL DEFAULT 'OPEN',
    `subtotalPaisa` BIGINT NOT NULL DEFAULT 0,
    `discountPaisa` BIGINT NOT NULL DEFAULT 0,
    `totalPaisa` BIGINT NOT NULL DEFAULT 0,
    `paidPaisa` BIGINT NOT NULL DEFAULT 0,
    `balancePaisa` BIGINT NOT NULL DEFAULT 0,
    `prescriptionAttachmentId` VARCHAR(191) NULL,
    `closedAt` DATETIME(3) NULL,
    `closedById` VARCHAR(191) NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `invoices_number_key`(`number`),
    UNIQUE INDEX `invoices_appointmentId_key`(`appointmentId`),
    INDEX `invoices_status_createdAt_idx`(`status`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `invoice_lines` (
    `id` VARCHAR(191) NOT NULL,
    `invoiceId` VARCHAR(191) NOT NULL,
    `description` VARCHAR(191) NOT NULL,
    `planItemId` VARCHAR(191) NULL,
    `quantity` INTEGER NOT NULL DEFAULT 1,
    `unitPricePaisa` BIGINT NOT NULL,
    `discountPaisa` BIGINT NOT NULL DEFAULT 0,
    `lineTotalPaisa` BIGINT NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `payments` (
    `id` VARCHAR(191) NOT NULL,
    `receiptNo` VARCHAR(191) NOT NULL,
    `invoiceId` VARCHAR(191) NOT NULL,
    `amountPaisa` BIGINT NOT NULL,
    `method` ENUM('CASH', 'CARD', 'BANK_ONLINE', 'CHEQUE') NOT NULL,
    `reference` VARCHAR(191) NULL,
    `bankAccountId` VARCHAR(191) NULL,
    `cashierId` VARCHAR(191) NOT NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `payments_receiptNo_key`(`receiptNo`),
    UNIQUE INDEX `payments_idempotencyKey_key`(`idempotencyKey`),
    INDEX `payments_receivedAt_idx`(`receivedAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `bank_accounts` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `bankName` VARCHAR(191) NOT NULL,
    `accountNo` VARCHAR(191) NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ledger_entries` (
    `id` VARCHAR(191) NOT NULL,
    `account` ENUM('CASH_IN_HAND', 'BANK', 'SUPPLIER_PAYABLE', 'PATIENT_RECEIVABLE') NOT NULL,
    `bankAccountId` VARCHAR(191) NULL,
    `vendorId` VARCHAR(191) NULL,
    `amountPaisa` BIGINT NOT NULL,
    `refType` VARCHAR(191) NOT NULL,
    `refId` VARCHAR(191) NOT NULL,
    `memo` VARCHAR(191) NULL,
    `actorId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `ledger_entries_account_createdAt_idx`(`account`, `createdAt`),
    INDEX `ledger_entries_vendorId_idx`(`vendorId`),
    INDEX `ledger_entries_bankAccountId_idx`(`bankAccountId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `cash_closings` (
    `id` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `expectedCashPaisa` BIGINT NOT NULL,
    `countedCashPaisa` BIGINT NOT NULL,
    `variancePaisa` BIGINT NOT NULL,
    `cardPaisa` BIGINT NOT NULL,
    `bankPaisa` BIGINT NOT NULL,
    `chequePaisa` BIGINT NOT NULL,
    `discountsPaisa` BIGINT NOT NULL,
    `notes` TEXT NULL,
    `cashierId` VARCHAR(191) NULL,
    `managerId` VARCHAR(191) NOT NULL,
    `signedOffAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `cash_closings_date_key`(`date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `workflow_tasks` (
    `id` VARCHAR(191) NOT NULL,
    `type` ENUM('RECEPTION_COLLECTION', 'RECEPTION_UPCOMING_PROCEDURE', 'MANAGER_STOCK_CHECK', 'MANAGER_ROOM_VERIFICATION', 'MANAGER_LEAVE_IMPACT', 'MANAGER_PATIENT_FOLLOWUP', 'MANAGER_ASSIGNMENT_MISSING', 'MANAGER_MESSAGE_FAILURE', 'DOCTOR_AFTERCARE', 'ROOM_OPENING', 'ROOM_CLOSING') NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `patientId` VARCHAR(191) NULL,
    `appointmentId` VARCHAR(191) NULL,
    `planItemId` VARCHAR(191) NULL,
    `roomId` VARCHAR(191) NULL,
    `assignedRole` ENUM('LEAD_MEMBER', 'RECEPTIONIST', 'DOCTOR', 'ASSISTANT', 'OFFICE_BOY', 'MANAGER', 'MD', 'MARKETING_DIRECTOR', 'MARKETING_LEAD') NOT NULL,
    `assignedUserId` VARCHAR(191) NULL,
    `dueAt` DATETIME(3) NULL,
    `currentStep` VARCHAR(191) NULL,
    `status` ENUM('PENDING', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `payload` JSON NULL,
    `idempotencyKey` VARCHAR(191) NULL,
    `completedAt` DATETIME(3) NULL,
    `completedById` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `workflow_tasks_idempotencyKey_key`(`idempotencyKey`),
    INDEX `workflow_tasks_assignedRole_status_idx`(`assignedRole`, `status`),
    INDEX `workflow_tasks_assignedUserId_status_idx`(`assignedUserId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `procedure_tasks` (
    `id` VARCHAR(191) NOT NULL,
    `planItemId` VARCHAR(191) NOT NULL,
    `appointmentId` VARCHAR(191) NULL,
    `patientId` VARCHAR(191) NOT NULL,
    `doctorId` VARCHAR(191) NOT NULL,
    `roomId` VARCHAR(191) NULL,
    `assistantId` VARCHAR(191) NULL,
    `status` ENUM('PENDING', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `currentStep` ENUM('ACCEPT', 'CONSENT', 'BEFORE_PHOTO', 'START', 'FINISH', 'AFTER_PHOTO', 'ITEMS_USED', 'ROOM_CLEAN', 'DONE') NOT NULL DEFAULT 'ACCEPT',
    `assignedAt` DATETIME(3) NULL,
    `acceptedAt` DATETIME(3) NULL,
    `consentAttachmentId` VARCHAR(191) NULL,
    `consentAt` DATETIME(3) NULL,
    `beforePhotoAttachmentId` VARCHAR(191) NULL,
    `beforePhotoSkipped` BOOLEAN NOT NULL DEFAULT false,
    `beforePhotoSkipReason` VARCHAR(191) NULL,
    `startedAt` DATETIME(3) NULL,
    `endedAt` DATETIME(3) NULL,
    `afterPhotoAttachmentId` VARCHAR(191) NULL,
    `afterPhotoSkipped` BOOLEAN NOT NULL DEFAULT false,
    `afterPhotoSkipReason` VARCHAR(191) NULL,
    `itemsUsedAt` DATETIME(3) NULL,
    `cleanAttachmentId` VARCHAR(191) NULL,
    `cleanedAt` DATETIME(3) NULL,
    `consentAlertAt` DATETIME(3) NULL,
    `cleanAlertAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `procedure_tasks_planItemId_key`(`planItemId`),
    INDEX `procedure_tasks_assistantId_status_idx`(`assistantId`, `status`),
    INDEX `procedure_tasks_status_currentStep_idx`(`status`, `currentStep`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `procedure_task_assignments` (
    `id` VARCHAR(191) NOT NULL,
    `procedureTaskId` VARCHAR(191) NOT NULL,
    `assistantId` VARCHAR(191) NOT NULL,
    `assignedById` VARCHAR(191) NOT NULL,
    `reason` VARCHAR(191) NULL,
    `resumedAtStep` ENUM('ACCEPT', 'CONSENT', 'BEFORE_PHOTO', 'START', 'FINISH', 'AFTER_PHOTO', 'ITEMS_USED', 'ROOM_CLEAN', 'DONE') NULL,
    `startedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `endedAt` DATETIME(3) NULL,

    INDEX `procedure_task_assignments_procedureTaskId_idx`(`procedureTaskId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `room_assignments` (
    `id` VARCHAR(191) NOT NULL,
    `assistantId` VARCHAR(191) NOT NULL,
    `roomId` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `assignedById` VARCHAR(191) NOT NULL,
    `acceptedAt` DATETIME(3) NULL,
    `unassignedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `room_assignments_assistantId_date_idx`(`assistantId`, `date`),
    INDEX `room_assignments_roomId_date_idx`(`roomId`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `room_checklist_reports` (
    `id` VARCHAR(191) NOT NULL,
    `assignmentId` VARCHAR(191) NOT NULL,
    `roomId` VARCHAR(191) NOT NULL,
    `assistantId` VARCHAR(191) NOT NULL,
    `kind` ENUM('OPENING', 'CLOSING') NOT NULL,
    `machineOk` BOOLEAN NOT NULL,
    `machineIssue` TEXT NULL,
    `roomNeat` BOOLEAN NOT NULL,
    `disinfected` BOOLEAN NOT NULL,
    `stockOk` BOOLEAN NOT NULL,
    `stockNotes` TEXT NULL,
    `demandSkipped` BOOLEAN NOT NULL DEFAULT false,
    `attachmentIds` JSON NULL,
    `submittedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `room_checklist_reports_assignmentId_kind_key`(`assignmentId`, `kind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `report_verifications` (
    `id` VARCHAR(191) NOT NULL,
    `reportType` VARCHAR(191) NOT NULL,
    `reportId` VARCHAR(191) NOT NULL,
    `status` ENUM('PENDING', 'VERIFIED', 'RETURNED', 'ESCALATED') NOT NULL,
    `comment` TEXT NULL,
    `verifiedById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `report_verifications_reportType_reportId_idx`(`reportType`, `reportId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `attendance` (
    `id` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `date` DATE NOT NULL,
    `checkInAt` DATETIME(3) NOT NULL,
    `checkOutAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `attendance_userId_date_key`(`userId`, `date`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `staff_reviews` (
    `id` VARCHAR(191) NOT NULL,
    `staffId` VARCHAR(191) NOT NULL,
    `attendanceId` VARCHAR(191) NULL,
    `reviewerId` VARCHAR(191) NOT NULL,
    `uniformOk` BOOLEAN NOT NULL,
    `hairOk` BOOLEAN NOT NULL,
    `nailsOk` BOOLEAN NOT NULL,
    `rating` INTEGER NOT NULL,
    `comment` TEXT NULL,
    `improvementNote` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `staff_reviews_staffId_createdAt_idx`(`staffId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `office_rounds` (
    `id` VARCHAR(191) NOT NULL,
    `officeBoyId` VARCHAR(191) NOT NULL,
    `attendanceId` VARCHAR(191) NOT NULL,
    `seq` INTEGER NOT NULL,
    `kind` ENUM('FIRST_CHECK', 'ROUND', 'FINAL') NOT NULL,
    `dueAt` DATETIME(3) NOT NULL,
    `submittedAt` DATETIME(3) NULL,
    `cleanlinessOk` BOOLEAN NULL,
    `stockOk` BOOLEAN NULL,
    `areas` JSON NULL,
    `issues` TEXT NULL,
    `attachmentIds` JSON NULL,
    `status` ENUM('PENDING', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `office_rounds_officeBoyId_status_idx`(`officeBoyId`, `status`),
    UNIQUE INDEX `office_rounds_attendanceId_seq_key`(`attendanceId`, `seq`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `leave_requests` (
    `id` VARCHAR(191) NOT NULL,
    `requesterId` VARCHAR(191) NOT NULL,
    `requesterRole` ENUM('LEAD_MEMBER', 'RECEPTIONIST', 'DOCTOR', 'ASSISTANT', 'OFFICE_BOY', 'MANAGER', 'MD', 'MARKETING_DIRECTOR', 'MARKETING_LEAD') NOT NULL,
    `kind` ENUM('LEAVE', 'EARLY_LEAVE') NOT NULL,
    `startAt` DATETIME(3) NOT NULL,
    `endAt` DATETIME(3) NOT NULL,
    `reason` TEXT NOT NULL,
    `coveragePlan` TEXT NULL,
    `approverRole` ENUM('LEAD_MEMBER', 'RECEPTIONIST', 'DOCTOR', 'ASSISTANT', 'OFFICE_BOY', 'MANAGER', 'MD', 'MARKETING_DIRECTOR', 'MARKETING_LEAD') NOT NULL,
    `status` ENUM('PENDING', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'RETURNED_FOR_CORRECTION', 'IN_PROGRESS', 'RESOLVED', 'NEED_DETAILS', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `decidedById` VARCHAR(191) NULL,
    `decidedAt` DATETIME(3) NULL,
    `decisionReason` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `leave_requests_approverRole_status_idx`(`approverRole`, `status`),
    INDEX `leave_requests_requesterId_idx`(`requesterId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `complaints` (
    `id` VARCHAR(191) NOT NULL,
    `source` ENUM('STAFF', 'LEAD', 'PATIENT', 'MANAGER') NOT NULL,
    `raisedById` VARCHAR(191) NULL,
    `patientId` VARCHAR(191) NULL,
    `appointmentId` VARCHAR(191) NULL,
    `subject` VARCHAR(191) NOT NULL,
    `detail` TEXT NOT NULL,
    `status` ENUM('PENDING', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'RETURNED_FOR_CORRECTION', 'IN_PROGRESS', 'RESOLVED', 'NEED_DETAILS', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `escalatedToMdAt` DATETIME(3) NULL,
    `resolvedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `complaints_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `complaint_recipients` (
    `id` VARCHAR(191) NOT NULL,
    `complaintId` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `addedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `complaint_recipients_userId_idx`(`userId`),
    UNIQUE INDEX `complaint_recipients_complaintId_userId_key`(`complaintId`, `userId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `approval_requests` (
    `id` VARCHAR(191) NOT NULL,
    `type` ENUM('STOCK_DEMAND', 'HISTORY_ACCESS', 'ALTERNATE_AVAILABILITY', 'ASSISTANT_REPLACEMENT', 'RESCHEDULE', 'DAMAGE_WRITE_OFF') NOT NULL,
    `subjectType` VARCHAR(191) NOT NULL,
    `subjectId` VARCHAR(191) NOT NULL,
    `requestedById` VARCHAR(191) NOT NULL,
    `approverRole` ENUM('LEAD_MEMBER', 'RECEPTIONIST', 'DOCTOR', 'ASSISTANT', 'OFFICE_BOY', 'MANAGER', 'MD', 'MARKETING_DIRECTOR', 'MARKETING_LEAD') NOT NULL,
    `status` ENUM('PENDING', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'RETURNED_FOR_CORRECTION', 'IN_PROGRESS', 'RESOLVED', 'NEED_DETAILS', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `reason` TEXT NULL,
    `decidedById` VARCHAR(191) NULL,
    `decidedAt` DATETIME(3) NULL,
    `decisionReason` TEXT NULL,
    `expiresAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `approval_requests_approverRole_status_idx`(`approverRole`, `status`),
    INDEX `approval_requests_subjectType_subjectId_idx`(`subjectType`, `subjectId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `history_access_requests` (
    `id` VARCHAR(191) NOT NULL,
    `doctorId` VARCHAR(191) NOT NULL,
    `patientId` VARCHAR(191) NOT NULL,
    `reason` TEXT NOT NULL,
    `status` ENUM('PENDING', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'RETURNED_FOR_CORRECTION', 'IN_PROGRESS', 'RESOLVED', 'NEED_DETAILS', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `decidedById` VARCHAR(191) NULL,
    `decidedAt` DATETIME(3) NULL,
    `decisionReason` TEXT NULL,
    `expiresAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `history_access_requests_doctorId_patientId_status_idx`(`doctorId`, `patientId`, `status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ad_requests` (
    `id` VARCHAR(191) NOT NULL,
    `requesterId` VARCHAR(191) NOT NULL,
    `sheetId` VARCHAR(191) NULL,
    `campaign` VARCHAR(191) NULL,
    `kind` ENUM('RADIUS_CHANGE', 'EDIT_AD', 'NEW_AD', 'ISSUE') NOT NULL,
    `detail` TEXT NOT NULL,
    `reason` TEXT NULL,
    `status` ENUM('PENDING', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'RETURNED_FOR_CORRECTION', 'IN_PROGRESS', 'RESOLVED', 'NEED_DETAILS', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    INDEX `ad_requests_requesterId_idx`(`requesterId`),
    INDEX `ad_requests_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `thread_messages` (
    `id` VARCHAR(191) NOT NULL,
    `threadType` VARCHAR(191) NOT NULL,
    `threadId` VARCHAR(191) NOT NULL,
    `authorId` VARCHAR(191) NOT NULL,
    `body` TEXT NOT NULL,
    `statusChange` ENUM('PENDING', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'RETURNED_FOR_CORRECTION', 'IN_PROGRESS', 'RESOLVED', 'NEED_DETAILS', 'COMPLETED', 'CANCELLED') NULL,
    `attachmentIds` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `thread_messages_threadType_threadId_createdAt_idx`(`threadType`, `threadId`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `offers` (
    `id` VARCHAR(191) NOT NULL,
    `title` VARCHAR(191) NOT NULL,
    `serviceName` VARCHAR(191) NULL,
    `description` TEXT NULL,
    `sheetId` VARCHAR(191) NULL,
    `validFrom` DATETIME(3) NOT NULL,
    `validTo` DATETIME(3) NOT NULL,
    `attachmentId` VARCHAR(191) NULL,
    `createdById` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `offers_validFrom_validTo_idx`(`validFrom`, `validTo`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `vendors` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `phone` VARCHAR(191) NULL,
    `address` TEXT NULL,
    `products` TEXT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `vendors_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stock_items` (
    `id` VARCHAR(191) NOT NULL,
    `name` VARCHAR(191) NOT NULL,
    `category` VARCHAR(191) NOT NULL,
    `baseUnit` VARCHAR(191) NOT NULL,
    `packUnit` VARCHAR(191) NULL,
    `packSize` INTEGER NULL,
    `minQty` INTEGER NOT NULL,
    `preferredVendorId` VARCHAR(191) NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `stock_items_name_key`(`name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stock_batches` (
    `id` VARCHAR(191) NOT NULL,
    `itemId` VARCHAR(191) NOT NULL,
    `lotNo` VARCHAR(191) NOT NULL,
    `expiryDate` DATE NULL,
    `vendorId` VARCHAR(191) NULL,
    `receiptLineId` VARCHAR(191) NULL,
    `unitCostPaisa` BIGINT NULL,
    `status` ENUM('AVAILABLE', 'QUARANTINED', 'EXPIRED', 'DEPLETED') NOT NULL DEFAULT 'AVAILABLE',
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `stock_batches_expiryDate_idx`(`expiryDate`),
    UNIQUE INDEX `stock_batches_itemId_lotNo_key`(`itemId`, `lotNo`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stock_transactions` (
    `id` VARCHAR(191) NOT NULL,
    `itemId` VARCHAR(191) NOT NULL,
    `batchId` VARCHAR(191) NULL,
    `type` ENUM('PURCHASE', 'USAGE', 'RETURN_TO_SUPPLIER', 'DAMAGE', 'ADJUSTMENT') NOT NULL,
    `quantity` INTEGER NOT NULL,
    `unitCostPaisa` BIGINT NULL,
    `procedureTaskId` VARCHAR(191) NULL,
    `demandId` VARCHAR(191) NULL,
    `receiptId` VARCHAR(191) NULL,
    `vendorId` VARCHAR(191) NULL,
    `reason` TEXT NULL,
    `actorId` VARCHAR(191) NOT NULL,
    `idempotencyKey` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `stock_transactions_idempotencyKey_key`(`idempotencyKey`),
    INDEX `stock_transactions_itemId_createdAt_idx`(`itemId`, `createdAt`),
    INDEX `stock_transactions_batchId_idx`(`batchId`),
    INDEX `stock_transactions_procedureTaskId_idx`(`procedureTaskId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stock_demands` (
    `id` VARCHAR(191) NOT NULL,
    `demandNumber` VARCHAR(191) NULL,
    `requestedById` VARCHAR(191) NOT NULL,
    `requesterRole` ENUM('LEAD_MEMBER', 'RECEPTIONIST', 'DOCTOR', 'ASSISTANT', 'OFFICE_BOY', 'MANAGER', 'MD', 'MARKETING_DIRECTOR', 'MARKETING_LEAD') NOT NULL,
    `reason` TEXT NOT NULL,
    `status` ENUM('DRAFT', 'PENDING_MANAGER', 'PENDING_MD', 'APPROVED', 'REJECTED', 'RETURNED_FOR_CORRECTION', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CLOSED') NOT NULL DEFAULT 'PENDING_MANAGER',
    `estimatedTotalPaisa` BIGINT NOT NULL DEFAULT 0,
    `approvedById` VARCHAR(191) NULL,
    `approvedAt` DATETIME(3) NULL,
    `decisionReason` TEXT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `stock_demands_demandNumber_key`(`demandNumber`),
    INDEX `stock_demands_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `stock_demand_lines` (
    `id` VARCHAR(191) NOT NULL,
    `demandId` VARCHAR(191) NOT NULL,
    `itemId` VARCHAR(191) NOT NULL,
    `quantity` INTEGER NOT NULL,
    `estUnitCostPaisa` BIGINT NOT NULL DEFAULT 0,
    `receivedQty` INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `goods_receipts` (
    `id` VARCHAR(191) NOT NULL,
    `demandId` VARCHAR(191) NULL,
    `vendorId` VARCHAR(191) NOT NULL,
    `vendorInvoiceNo` VARCHAR(191) NULL,
    `attachmentId` VARCHAR(191) NULL,
    `totalPaisa` BIGINT NOT NULL,
    `receivedById` VARCHAR(191) NOT NULL,
    `idempotencyKey` VARCHAR(191) NULL,
    `receivedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `goods_receipts_idempotencyKey_key`(`idempotencyKey`),
    INDEX `goods_receipts_vendorId_idx`(`vendorId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `goods_receipt_lines` (
    `id` VARCHAR(191) NOT NULL,
    `receiptId` VARCHAR(191) NOT NULL,
    `demandLineId` VARCHAR(191) NULL,
    `itemId` VARCHAR(191) NOT NULL,
    `quantity` INTEGER NOT NULL,
    `unitCostPaisa` BIGINT NOT NULL,
    `lotNo` VARCHAR(191) NOT NULL,
    `expiryDate` DATE NULL,
    `batchId` VARCHAR(191) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `supplier_returns` (
    `id` VARCHAR(191) NOT NULL,
    `vendorId` VARCHAR(191) NOT NULL,
    `receiptId` VARCHAR(191) NULL,
    `itemId` VARCHAR(191) NOT NULL,
    `batchId` VARCHAR(191) NOT NULL,
    `quantity` INTEGER NOT NULL,
    `creditPaisa` BIGINT NOT NULL,
    `reason` TEXT NOT NULL,
    `actorId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `supplier_payments` (
    `id` VARCHAR(191) NOT NULL,
    `vendorId` VARCHAR(191) NOT NULL,
    `amountPaisa` BIGINT NOT NULL,
    `method` ENUM('CASH', 'CARD', 'BANK_ONLINE', 'CHEQUE') NOT NULL,
    `reference` VARCHAR(191) NULL,
    `bankAccountId` VARCHAR(191) NULL,
    `actorId` VARCHAR(191) NOT NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `paidAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `supplier_payments_idempotencyKey_key`(`idempotencyKey`),
    INDEX `supplier_payments_vendorId_idx`(`vendorId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `damage_reports` (
    `id` VARCHAR(191) NOT NULL,
    `itemId` VARCHAR(191) NOT NULL,
    `batchId` VARCHAR(191) NULL,
    `quantity` INTEGER NOT NULL,
    `reason` TEXT NOT NULL,
    `attachmentId` VARCHAR(191) NULL,
    `reportedById` VARCHAR(191) NOT NULL,
    `status` ENUM('PENDING', 'IN_REVIEW', 'APPROVED', 'REJECTED', 'RETURNED_FOR_CORRECTION', 'IN_PROGRESS', 'RESOLVED', 'NEED_DETAILS', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `reviewedById` VARCHAR(191) NULL,
    `reviewedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `feedback` (
    `id` VARCHAR(191) NOT NULL,
    `appointmentId` VARCHAR(191) NOT NULL,
    `patientId` VARCHAR(191) NOT NULL,
    `token` VARCHAR(191) NOT NULL,
    `skipped` BOOLEAN NOT NULL DEFAULT false,
    `doctorRating` INTEGER NULL,
    `staffRating` INTEGER NULL,
    `clinicRating` INTEGER NULL,
    `suggestion` TEXT NULL,
    `submittedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `feedback_appointmentId_key`(`appointmentId`),
    UNIQUE INDEX `feedback_token_key`(`token`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `follow_ups` (
    `id` VARCHAR(191) NOT NULL,
    `patientId` VARCHAR(191) NOT NULL,
    `appointmentId` VARCHAR(191) NOT NULL,
    `dueDate` DATE NOT NULL,
    `doctorRating` INTEGER NULL,
    `staffRating` INTEGER NULL,
    `clinicRating` INTEGER NULL,
    `issue` TEXT NULL,
    `suggestion` TEXT NULL,
    `complaintId` VARCHAR(191) NULL,
    `status` ENUM('PENDING', 'IN_PROGRESS', 'BLOCKED', 'COMPLETED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `completedById` VARCHAR(191) NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `follow_ups_appointmentId_key`(`appointmentId`),
    INDEX `follow_ups_status_dueDate_idx`(`status`, `dueDate`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `aftercare` (
    `id` VARCHAR(191) NOT NULL,
    `appointmentId` VARCHAR(191) NOT NULL,
    `doctorId` VARCHAR(191) NOT NULL,
    `skipped` BOOLEAN NOT NULL,
    `content` TEXT NULL,
    `outboxId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `aftercare_appointmentId_key`(`appointmentId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `notifications` (
    `id` VARCHAR(191) NOT NULL,
    `recipientId` VARCHAR(191) NOT NULL,
    `senderId` VARCHAR(191) NULL,
    `senderLabel` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `subject` VARCHAR(191) NOT NULL,
    `body` TEXT NULL,
    `recordType` VARCHAR(191) NULL,
    `recordId` VARCHAR(191) NULL,
    `actionLabel` VARCHAR(191) NULL,
    `priority` INTEGER NOT NULL DEFAULT 0,
    `dedupeKey` VARCHAR(191) NULL,
    `readAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `notifications_dedupeKey_key`(`dedupeKey`),
    INDEX `notifications_recipientId_readAt_createdAt_idx`(`recipientId`, `readAt`, `createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `message_outbox` (
    `id` VARCHAR(191) NOT NULL,
    `channel` ENUM('WHATSAPP', 'SMS') NOT NULL,
    `template` VARCHAR(191) NOT NULL,
    `toPhone` VARCHAR(191) NOT NULL,
    `patientId` VARCHAR(191) NULL,
    `recipientUserId` VARCHAR(191) NULL,
    `payload` JSON NOT NULL,
    `relatedType` VARCHAR(191) NULL,
    `relatedId` VARCHAR(191) NULL,
    `status` ENUM('QUEUED', 'SENDING', 'SENT', 'DELIVERED', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'QUEUED',
    `retryCount` INTEGER NOT NULL DEFAULT 0,
    `nextAttemptAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `lastError` TEXT NULL,
    `errorClass` VARCHAR(191) NULL,
    `terminal` BOOLEAN NOT NULL DEFAULT false,
    `providerMessageId` VARCHAR(191) NULL,
    `providerResponse` JSON NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `createdById` VARCHAR(191) NULL,
    `sentAt` DATETIME(3) NULL,
    `deliveredAt` DATETIME(3) NULL,
    `failedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `updatedAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `message_outbox_providerMessageId_key`(`providerMessageId`),
    UNIQUE INDEX `message_outbox_idempotencyKey_key`(`idempotencyKey`),
    INDEX `message_outbox_status_nextAttemptAt_idx`(`status`, `nextAttemptAt`),
    INDEX `message_outbox_relatedType_relatedId_idx`(`relatedType`, `relatedId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `jobs` (
    `id` VARCHAR(191) NOT NULL,
    `type` VARCHAR(191) NOT NULL,
    `runAt` DATETIME(3) NOT NULL,
    `payload` JSON NULL,
    `status` ENUM('PENDING', 'RUNNING', 'DONE', 'FAILED', 'CANCELLED') NOT NULL DEFAULT 'PENDING',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `lockedAt` DATETIME(3) NULL,
    `lockedBy` VARCHAR(191) NULL,
    `lastError` TEXT NULL,
    `idempotencyKey` VARCHAR(191) NOT NULL,
    `completedAt` DATETIME(3) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `jobs_idempotencyKey_key`(`idempotencyKey`),
    INDEX `jobs_status_runAt_idx`(`status`, `runAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `idempotency_records` (
    `id` VARCHAR(191) NOT NULL,
    `key` VARCHAR(191) NOT NULL,
    `userId` VARCHAR(191) NOT NULL,
    `method` VARCHAR(191) NOT NULL,
    `path` VARCHAR(512) NOT NULL,
    `requestHash` VARCHAR(191) NOT NULL,
    `statusCode` INTEGER NULL,
    `responseBody` JSON NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    `expiresAt` DATETIME(3) NOT NULL,

    UNIQUE INDEX `idempotency_records_userId_key_key`(`userId`, `key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_events` (
    `id` BIGINT NOT NULL AUTO_INCREMENT,
    `actorId` VARCHAR(191) NULL,
    `actorRole` ENUM('LEAD_MEMBER', 'RECEPTIONIST', 'DOCTOR', 'ASSISTANT', 'OFFICE_BOY', 'MANAGER', 'MD', 'MARKETING_DIRECTOR', 'MARKETING_LEAD') NULL,
    `action` VARCHAR(191) NOT NULL,
    `recordType` VARCHAR(191) NOT NULL,
    `recordId` VARCHAR(191) NULL,
    `before` JSON NULL,
    `after` JSON NULL,
    `reason` TEXT NULL,
    `ip` VARCHAR(191) NULL,
    `requestId` VARCHAR(191) NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    INDEX `audit_events_recordType_recordId_idx`(`recordType`, `recordId`),
    INDEX `audit_events_actorId_createdAt_idx`(`actorId`, `createdAt`),
    INDEX `audit_events_action_createdAt_idx`(`action`, `createdAt`),
    INDEX `audit_events_createdAt_idx`(`createdAt`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `settings` (
    `key` VARCHAR(191) NOT NULL,
    `value` JSON NOT NULL,
    `isPlaceholder` BOOLEAN NOT NULL DEFAULT true,
    `description` TEXT NOT NULL,
    `updatedById` VARCHAR(191) NULL,
    `updatedAt` DATETIME(3) NOT NULL,

    PRIMARY KEY (`key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `attachments` (
    `id` VARCHAR(191) NOT NULL,
    `fileKey` VARCHAR(191) NOT NULL,
    `route` ENUM('consentForm', 'prescriptionPhoto', 'beforePhoto', 'afterPhoto', 'itemsUsedEvidence', 'roomCleanPhoto', 'roomChecklistPhoto', 'machineIssuePhoto', 'damagePhoto', 'adCreative', 'requestAttachment', 'complaintAttachment', 'vendorInvoice') NOT NULL,
    `fileName` VARCHAR(191) NOT NULL,
    `mime` VARCHAR(191) NOT NULL,
    `size` INTEGER NOT NULL,
    `isPrivate` BOOLEAN NOT NULL,
    `publicUrl` VARCHAR(191) NULL,
    `uploadedById` VARCHAR(191) NOT NULL,
    `recordType` VARCHAR(191) NOT NULL,
    `recordId` VARCHAR(191) NOT NULL,
    `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

    UNIQUE INDEX `attachments_fileKey_key`(`fileKey`),
    INDEX `attachments_recordType_recordId_idx`(`recordType`, `recordId`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sequences` (
    `name` VARCHAR(191) NOT NULL,
    `value` INTEGER NOT NULL DEFAULT 0,

    PRIMARY KEY (`name`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `users` ADD CONSTRAINT `users_createdById_fkey` FOREIGN KEY (`createdById`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sessions` ADD CONSTRAINT `sessions_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `password_reset_tokens` ADD CONSTRAINT `password_reset_tokens_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `lead_member_profiles` ADD CONSTRAINT `lead_member_profiles_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `doctor_profiles` ADD CONSTRAINT `doctor_profiles_userId_fkey` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sheet_assignments` ADD CONSTRAINT `sheet_assignments_sheetId_fkey` FOREIGN KEY (`sheetId`) REFERENCES `meta_sheets`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `leads` ADD CONSTRAINT `leads_sheetId_fkey` FOREIGN KEY (`sheetId`) REFERENCES `meta_sheets`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `lead_activities` ADD CONSTRAINT `lead_activities_leadId_fkey` FOREIGN KEY (`leadId`) REFERENCES `leads`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `lead_callbacks` ADD CONSTRAINT `lead_callbacks_leadId_fkey` FOREIGN KEY (`leadId`) REFERENCES `leads`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `appointments` ADD CONSTRAINT `appointments_patientId_fkey` FOREIGN KEY (`patientId`) REFERENCES `patients`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `appointment_status_history` ADD CONSTRAINT `appointment_status_history_appointmentId_fkey` FOREIGN KEY (`appointmentId`) REFERENCES `appointments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `room_reservations` ADD CONSTRAINT `room_reservations_roomId_fkey` FOREIGN KEY (`roomId`) REFERENCES `rooms`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `room_reservations` ADD CONSTRAINT `room_reservations_appointmentId_fkey` FOREIGN KEY (`appointmentId`) REFERENCES `appointments`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `vitals` ADD CONSTRAINT `vitals_appointmentId_fkey` FOREIGN KEY (`appointmentId`) REFERENCES `appointments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `treatment_plan_versions` ADD CONSTRAINT `treatment_plan_versions_planId_fkey` FOREIGN KEY (`planId`) REFERENCES `treatment_plans`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `treatment_plan_items` ADD CONSTRAINT `treatment_plan_items_versionId_fkey` FOREIGN KEY (`versionId`) REFERENCES `treatment_plan_versions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `installments` ADD CONSTRAINT `installments_versionId_fkey` FOREIGN KEY (`versionId`) REFERENCES `treatment_plan_versions`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `invoice_lines` ADD CONSTRAINT `invoice_lines_invoiceId_fkey` FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `payments` ADD CONSTRAINT `payments_invoiceId_fkey` FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `procedure_task_assignments` ADD CONSTRAINT `procedure_task_assignments_procedureTaskId_fkey` FOREIGN KEY (`procedureTaskId`) REFERENCES `procedure_tasks`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `room_checklist_reports` ADD CONSTRAINT `room_checklist_reports_assignmentId_fkey` FOREIGN KEY (`assignmentId`) REFERENCES `room_assignments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `complaint_recipients` ADD CONSTRAINT `complaint_recipients_complaintId_fkey` FOREIGN KEY (`complaintId`) REFERENCES `complaints`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_batches` ADD CONSTRAINT `stock_batches_itemId_fkey` FOREIGN KEY (`itemId`) REFERENCES `stock_items`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_transactions` ADD CONSTRAINT `stock_transactions_itemId_fkey` FOREIGN KEY (`itemId`) REFERENCES `stock_items`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `stock_demand_lines` ADD CONSTRAINT `stock_demand_lines_demandId_fkey` FOREIGN KEY (`demandId`) REFERENCES `stock_demands`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `goods_receipt_lines` ADD CONSTRAINT `goods_receipt_lines_receiptId_fkey` FOREIGN KEY (`receiptId`) REFERENCES `goods_receipts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

