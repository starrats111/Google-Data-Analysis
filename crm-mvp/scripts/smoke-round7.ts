/* 第七轮修复冒烟：image-guard（魔数/SSRF/整备）+ 宽度口径 */
import { sniffImageFormat, assertPublicImageUrl, prepareImageForGoogleAds } from "../src/lib/image-guard";
import { googleAdsTextWidth, truncateByWidth } from "../src/lib/ad-text-width";

let pass = 0, fail = 0;
function check(name: string, cond: boolean) {
  if (cond) { pass++; console.log(`  ok  ${name}`); }
  else { fail++; console.error(`FAIL  ${name}`); }
}

async function main() {
  // ── 魔数嗅探 ──
  check("jpeg 魔数", sniffImageFormat(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0])) === "jpeg");
  check("png 魔数", sniffImageFormat(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0])) === "png");
  const webp = Buffer.alloc(16); webp.write("RIFF", 0); webp.write("WEBP", 8);
  check("webp 魔数", sniffImageFormat(webp) === "webp");
  check("svg 文本", sniffImageFormat(Buffer.from('<?xml version="1.0"?><svg xmlns="..."></svg>')) === "svg");
  check("非图片 → null", sniffImageFormat(Buffer.from("hello world, definitely not an image")) === null);

  // ── SSRF 阀 ──
  check("拦 localhost", (await assertPublicImageUrl("http://localhost/x.png")) !== null);
  check("拦 127.0.0.1", (await assertPublicImageUrl("http://127.0.0.1/x.png")) !== null);
  check("拦 10.x", (await assertPublicImageUrl("http://10.1.2.3/x.png")) !== null);
  check("拦 169.254 metadata", (await assertPublicImageUrl("http://169.254.169.254/latest/meta-data/")) !== null);
  check("拦 192.168", (await assertPublicImageUrl("https://192.168.1.1/a.jpg")) !== null);
  check("拦 ftp 协议", (await assertPublicImageUrl("ftp://example.com/x.png")) !== null);
  check("放行公网 IP", (await assertPublicImageUrl("https://8.8.8.8/x.png")) === null);

  // ── prepareImageForGoogleAds（用 sharp 造图） ──
  let sharp: typeof import("sharp") | null = null;
  try { sharp = (await import("sharp")).default as unknown as typeof import("sharp"); } catch {}
  if (sharp) {
    const bigJpeg = await sharp({ create: { width: 800, height: 600, channels: 3, background: "#3366cc" } }).jpeg().toBuffer();
    const prepared1 = await prepareImageForGoogleAds(bigJpeg);
    check("800x600 jpeg 原样通过", !!prepared1 && prepared1.format === "jpeg" && !prepared1.transcoded);

    const smallPng = await sharp({ create: { width: 100, height: 100, channels: 3, background: "#000" } }).png().toBuffer();
    check("100x100 过小 → 丢弃", (await prepareImageForGoogleAds(smallPng)) === null);

    const webpImg = await sharp({ create: { width: 640, height: 480, channels: 3, background: "#cc3366" } }).webp().toBuffer();
    const prepared2 = await prepareImageForGoogleAds(webpImg);
    check("webp → 转码 jpeg", !!prepared2 && prepared2.format === "jpeg" && prepared2.transcoded === true);

    const alphaWebp = await sharp({ create: { width: 400, height: 400, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0.5 } } }).webp().toBuffer();
    const prepared3 = await prepareImageForGoogleAds(alphaWebp);
    check("带透明 webp → png", !!prepared3 && prepared3.format === "png");

    check("垃圾字节 → 丢弃", (await prepareImageForGoogleAds(Buffer.from("garbage data not an image at all"))) === null);
  } else {
    console.warn("sharp 不可用，跳过整备用例");
  }

  // ── 宽度口径 ──
  check("CJK 宽度=2/字", googleAdsTextWidth("日本語") === 6);
  check("ASCII 宽度=1/字", googleAdsTextWidth("hello") === 5);
  check("截断不劈码点", truncateByWidth("日本語のテスト", 5) === "日本");

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
