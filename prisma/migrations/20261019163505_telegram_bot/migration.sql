-- CreateEnum
CREATE TYPE "TelegramChatType" AS ENUM ('PRIVATE', 'GROUP', 'SUPERGROUP', 'CHANNEL');

-- AlterTable
ALTER TABLE "User" ADD COLUMN     "telegramLinkTokenExpiresAt" TIMESTAMP(3),
ADD COLUMN     "telegramLinkTokenHash" TEXT;

-- CreateTable
CREATE TABLE "TelegramChat" (
    "chatId" BIGINT NOT NULL,
    "type" "TelegramChatType" NOT NULL,
    "urgentUntil" TIMESTAMP(3),
    "filters" "Feature"[] DEFAULT ARRAY[]::"Feature"[],
    "areaType" "AreaType",
    "openNow" BOOLEAN NOT NULL DEFAULT false,
    "userId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramChat_pkey" PRIMARY KEY ("chatId")
);

-- CreateIndex
CREATE UNIQUE INDEX "TelegramChat_userId_key" ON "TelegramChat"("userId");

-- AddForeignKey
ALTER TABLE "TelegramChat" ADD CONSTRAINT "TelegramChat_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
