// 图标压缩：用 Electron 自带 nativeImage 重采样并重新编码 PNG
// 用法: electron tools/compress-icon.js <源图> <输出图> <边长> [--quality best|good]
//   best  -> toPNG()           无损，体积略大
//   good  -> 先转 JPEG 再转回 PNG（有损，但纯色/渐变图标体积可大幅下降）
const { app, nativeImage } = require("electron");
const fs = require("fs");
const path = require("path");

const [src, out, sizeArg, qualityArg] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
const size = parseInt(sizeArg || "256", 10);

app.whenReady().then(() => {
  const img = nativeImage.createFromPath(src);
  if (img.isEmpty()) {
    console.error("无法读取源图:", src);
    app.exit(1);
    return;
  }
  const orig = img.getSize();
  const resized = img.resize({ width: size, height: size, quality: "best" });

  let buf;
  if (flags.includes("--jpeg-roundtrip")) {
    // 通过 JPEG 中转压缩：纯色平涂图标掉体积明显，边缘会有极轻微振铃
    const jpeg = resized.toJPEG(92);
    buf = nativeImage.createFromBuffer(jpeg).toPNG();
  } else {
    buf = resized.toPNG();
  }

  fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
  fs.writeFileSync(out, buf);

  // 回读校验
  const check = nativeImage.createFromPath(out);
  console.log(JSON.stringify({
    src,
    out,
    srcSize: fs.statSync(src).size,
    srcDim: `${orig.width}x${orig.height}`,
    outSize: buf.length,
    outDim: `${check.getSize().width}x${check.getSize().height}`,
    readable: !check.isEmpty(),
    mode: flags.includes("--jpeg-roundtrip") ? "jpeg-roundtrip" : "lossless",
  }));
  app.exit(0);
});
