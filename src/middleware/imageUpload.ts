/**
 * Multer memory-storage middleware for image uploads (panel photos). Buffers
 * stay in memory and are streamed to Spaces by storage.service — nothing is
 * written to local disk.
 */
import multer from 'multer';

const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE) || 10 * 1024 * 1024; // 10 MB

export const imageUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_SIZE },
  fileFilter: (_req, file, cb) => {
    if (/^image\/(jpe?g|png|heic|webp)$/i.test(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error('Only JPEG, PNG, HEIC, or WEBP images are allowed'));
    }
  },
});
