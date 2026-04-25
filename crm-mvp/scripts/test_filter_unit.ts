import { isQualityImageUrl } from "../src/lib/crawler";

const merchantDomain = "byfood.com";

const tests: Array<{ url: string; expected: boolean; reason: string }> = [
  { url: "https://media-cdn.tripadvisor.com/media/attractions-splice-spp-720x480/10/11/73/f8.jpg", expected: false, reason: "TripAdvisor 防盗链 CDN" },
  { url: "https://byfood.b-cdn.net/static/sakurabyfood/blossom.png?optimizer=image", expected: false, reason: "static UI 装饰" },
  { url: "https://byfood.b-cdn.net/static/checkout/select-chevron.png?optimizer=image", expected: false, reason: "select chevron UI" },
  { url: "https://byfood.b-cdn.net/static/listing/bowl-chopstick.png?optimizer=image", expected: false, reason: "bowl-chopstick UI" },
  { url: "https://byfood.b-cdn.net/static/listing/instant-confirmation.png?optimizer=image", expected: false, reason: "instant-confirmation UI" },
  { url: "https://byfood.b-cdn.net/static/header-menu/cities/jp/Tokyo.jpg?optimizer=image&width=300", expected: false, reason: "header-menu/cities 导航图" },
  { url: "https://byfood.b-cdn.net/static/header-menu/cities/global/Paris.jpg?optimizer=image&width=300", expected: false, reason: "header-menu/cities 导航图" },
  { url: "https://www.byfood.com/static/close-icon.svg", expected: false, reason: "SVG icon" },
  { url: "https://byfood.b-cdn.net/static/cart.svg?optimizer=image", expected: false, reason: "SVG cart" },
  { url: "https://byfood.b-cdn.net/static/footer/visa.svg?optimizer=image", expected: false, reason: "支付图标" },
  { url: "https://byfood.b-cdn.net/static/footer/mastercard.svg?optimizer=image", expected: false, reason: "支付图标" },
  { url: "https://byfood.b-cdn.net/static/notfound.svg?optimizer=image", expected: false, reason: "SVG 404 图" },
  // 真实产品图（应该放行）
  { url: "https://byfood.b-cdn.net/uploads/tours/sushi-making-tokyo.jpg", expected: true, reason: "tours 子目录的真实产品图" },
  { url: "https://www.byfood.com/uploads/restaurants/ramen-shop.jpg", expected: true, reason: "餐厅图" },
];

let pass = 0;
let fail = 0;
for (const t of tests) {
  const got = isQualityImageUrl(t.url, merchantDomain);
  const ok = got === t.expected;
  if (ok) pass++;
  else fail++;
  console.log(`${ok ? "PASS" : "FAIL"}  expected=${t.expected} got=${got}  ${t.reason}`);
  console.log(`      ${t.url}`);
}
console.log(`\n=== ${pass} pass, ${fail} fail ===`);
process.exit(fail > 0 ? 1 : 0);
