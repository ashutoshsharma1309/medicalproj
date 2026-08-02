-- AlterTable
ALTER TABLE "Document" ADD COLUMN     "confidence" DOUBLE PRECISION,
ADD COLUMN     "extractionStatus" TEXT NOT NULL DEFAULT 'EXTRACTED',
ADD COLUMN     "fileSize" INTEGER,
ADD COLUMN     "fileType" TEXT,
ADD COLUMN     "storagePath" TEXT;

-- AlterTable
ALTER TABLE "Patient" ADD COLUMN     "emergencyContactName" TEXT,
ADD COLUMN     "emergencyContactPhone" TEXT,
ADD COLUMN     "profileCompleted" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "surgeries" TEXT;
