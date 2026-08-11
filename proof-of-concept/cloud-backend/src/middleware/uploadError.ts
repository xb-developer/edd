import type { NextFunction, Request, Response } from "express";
import multer from "multer";

/**
 * multer's fileSize limit throws inside the upload middleware, before the
 * route handler's own try/catch ever runs, so an oversized file otherwise
 * falls through to Express's default error handler and comes back as a bare
 * HTML page — the web client (web/src/api.ts) can only show a clean message
 * when the body is JSON with an `error`/`detail` field, same as every other
 * error path in this API.
 */
export function handleUploadError(maxUploadBytes: number) {
  return (err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (err instanceof multer.MulterError && err.code === "LIMIT_FILE_SIZE") {
      res.status(413).json({
        error: "file_too_large",
        detail: `Files are limited to ${Math.floor(maxUploadBytes / (1024 * 1024 * 1024))}GB`,
      });
      return;
    }
    next(err);
  };
}
