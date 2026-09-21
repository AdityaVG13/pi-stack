// Isolated decoder: no guest code or user image paths/contents in argv.
// The parent enforces a wall-clock kill and serializes raster allocations.
import sharp from "sharp";

const MAX_PIXELS = 32_000_000;
async function inputBytes() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 20 * 1024 * 1024) throw new Error("encoded image exceeds 20 MiB");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks,size);
}

async function decode() {
  const image = sharp(await inputBytes(),{failOn:"warning",limitInputPixels:MAX_PIXELS,pages:-1}).timeout({seconds:5});
  try {
    const meta = await image.metadata();
    if ("image/" + meta.format !== process.argv[2]) throw new Error("encoded format does not match declared MIME");
    if (meta.width * meta.height > MAX_PIXELS) throw new Error("decoded pixel limit exceeded");
    // Full decode, without resizing or shrinking that could conceal corruption.
    // No decoded pixels cross back into the agent process.
    await image.raw().toBuffer();
  } finally { image.destroy(); }
}

try { await decode(); }
catch (error) { process.stderr.write(String(error.message).slice(0,2048)); process.exitCode = 1; }
