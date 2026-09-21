export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const LARGE_FILE_BYTES = 512 * 1024;
export const TEXT_MAX_BYTES = 64 * 1024 * 1024;

export const ABOUT_TOKEN_MAX = 16;
export const IMAGE_MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".bmp": "image/bmp",
};

export function imageTooLarge(rel, size) {
  return new Error("image " + rel + " is " + size + " bytes (" + (size / 1024 / 1024).toFixed(1) + " MiB); the image read limit is " + IMAGE_MAX_BYTES + " bytes (20 MiB); resize or select fewer/smaller images");
}

export function missingFile(targetPath) {
  const error = new Error("no such file: " + targetPath + " (locate it with read using a directory path or source question; use Promise.allSettled for optional reads to retain successful siblings)");
  error.code = "ENOENT";
  return error;
}
