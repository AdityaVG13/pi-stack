export const IMAGE_MAX_BYTES = 20 * 1024 * 1024;
export const LARGE_FILE_BYTES = 512 * 1024;

/** Raw path-only reads above these must use json/about/offset/complete. */
export const RAW_JSON_CHARS = 4096;

export const RAW_SOURCE_CHARS = 8192;

export const RAW_SOURCE_LINES = 160;
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
  const error = new Error("no such file: " + targetPath + " (locate it with read using a directory path or source question)");
  error.code = "ENOENT";
  return error;
}
