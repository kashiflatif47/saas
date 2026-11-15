import multer from 'multer';
import { env } from '../config/env';

/** Multipart parsing for image uploads: kept in memory, size-limited; the bytes are validated and stored by services/media.ts. */
export const uploadMemory = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.MAX_UPLOAD_MB * 1024 * 1024, files: 8 },
});

/*
 * Images are no longer written to the app folder here. Every upload goes through services/media.ts (uploadAsset),
 * which stores it in permanent storage (Cloudinary, S3-compatible, or a verified persistent folder) and records an
 * Asset. Existing /uploads/... files are still served by app.ts until they are migrated (scripts/migrateAssets.ts),
 * and they are never deleted by the application.
 */
