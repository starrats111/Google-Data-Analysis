/**
 * C-016 safe-ad-template
 *
 * 职责：AI 3 轮单条 retry 仍违规时的**最终兜底模板**。
 * 原则：
 *   - 0 数字（无价格/百分比/电话）
 *   - 0 承诺（无 "guarantee / free / best / lifetime"）
 *   - 0 绝对化词
 *   - 纯通用价值词 + 品牌根名 + market 类目基础词
 *   - 严格遵守 Google Ads 官方政策的"保守底线"
 *
 * 使用方：ai-retry-loop.ts 的降级路径。
 */

import { getAdMarketConfig } from "@/lib/ad-market";

type Lang = "en" | "de" | "fr" | "nl" | "it" | "es" | "pt" | "sv" | "no" | "da" | "fi" | "pl" | "ja" | "ko" | "zh" | "zh-TW";

interface SafeLangPack {
  // 标题：brandRoot + 通用修饰
  headlines: (brandRoot: string) => string[];
  // 描述（50-90 chars，多条，第 n 条可用）
  descriptions: (brandRoot: string) => string[];
  // Sitelink: home/shop/contact/about
  sitelinks: Record<"home" | "shop" | "contact" | "about", { title: string; desc1: string; desc2: string }>;
  // 描述补位词（category 未知时用）
  categoryWord: string;
}

const PACK_EN: SafeLangPack = {
  headlines: (b) => [
    `${b} Official Site`,
    `${b} — Shop Online`,
    `${b} Store`,
    `Visit ${b} Online`,
    `${b} — Browse Catalog`,
  ],
  descriptions: (b) => [
    `Explore the official ${b} online catalog and find what fits your needs.`,
    `Shop the ${b} collection online with clear product details and support.`,
    `Browse ${b} products online and learn more about the brand and its range.`,
    `Discover ${b} online — product information, support and service.`,
  ],
  sitelinks: {
    home: { title: "Home", desc1: "Official homepage", desc2: "Browse online" },
    shop: { title: "Shop", desc1: "Browse products", desc2: "Online store" },
    contact: { title: "Contact", desc1: "Customer support", desc2: "Get in touch" },
    about: { title: "About", desc1: "About the brand", desc2: "Learn more" },
  },
  categoryWord: "products",
};

const PACK_DE: SafeLangPack = {
  headlines: (b) => [
    `${b} Offizielle Seite`,
    `${b} — Online Shop`,
    `${b} Store`,
    `${b} Online Besuchen`,
    `${b} — Produkte Ansehen`,
  ],
  descriptions: (b) => [
    `Entdecken Sie den offiziellen ${b} Online-Katalog mit detaillierten Produktinformationen.`,
    `Online-Shop von ${b} — klare Produktdetails und zuverlässiger Service.`,
    `Stöbern Sie in den ${b} Produkten online und erfahren Sie mehr über die Marke.`,
    `Erfahren Sie mehr über ${b} online — Produktinformationen und Kundenservice.`,
  ],
  sitelinks: {
    home: { title: "Startseite", desc1: "Offizielle Startseite", desc2: "Online stöbern" },
    shop: { title: "Shop", desc1: "Produkte ansehen", desc2: "Online-Shop" },
    contact: { title: "Kontakt", desc1: "Kundenservice", desc2: "Kontaktformular" },
    about: { title: "Über uns", desc1: "Über die Marke", desc2: "Mehr erfahren" },
  },
  categoryWord: "Produkte",
};

const PACK_FR: SafeLangPack = {
  headlines: (b) => [
    `${b} Site Officiel`,
    `${b} — Boutique en Ligne`,
    `Magasin ${b}`,
    `Visitez ${b} en Ligne`,
    `${b} — Catalogue`,
  ],
  descriptions: (b) => [
    `Découvrez le catalogue officiel ${b} en ligne avec des informations produit détaillées.`,
    `Boutique ${b} en ligne — informations produit claires et service fiable.`,
    `Parcourez les produits ${b} en ligne et découvrez la marque.`,
    `En savoir plus sur ${b} en ligne — informations produit et service client.`,
  ],
  sitelinks: {
    home: { title: "Accueil", desc1: "Page d'accueil officielle", desc2: "Parcourir en ligne" },
    shop: { title: "Boutique", desc1: "Voir les produits", desc2: "Boutique en ligne" },
    contact: { title: "Contact", desc1: "Service client", desc2: "Nous contacter" },
    about: { title: "À propos", desc1: "À propos de la marque", desc2: "En savoir plus" },
  },
  categoryWord: "produits",
};

const PACK_NL: SafeLangPack = {
  headlines: (b) => [
    `${b} Officiële Site`,
    `${b} — Online Winkel`,
    `${b} Webshop`,
    `Bezoek ${b} Online`,
    `${b} — Catalogus`,
  ],
  descriptions: (b) => [
    `Ontdek de officiële ${b} online catalogus met gedetailleerde productinformatie.`,
    `${b} webshop online — duidelijke productdetails en betrouwbare service.`,
    `Bekijk de ${b} producten online en leer meer over het merk.`,
    `Meer weten over ${b} online — productinformatie en klantenservice.`,
  ],
  sitelinks: {
    home: { title: "Startpagina", desc1: "Officiële startpagina", desc2: "Online bekijken" },
    shop: { title: "Shop", desc1: "Producten bekijken", desc2: "Online winkel" },
    contact: { title: "Contact", desc1: "Klantenservice", desc2: "Neem contact op" },
    about: { title: "Over ons", desc1: "Over het merk", desc2: "Meer informatie" },
  },
  categoryWord: "producten",
};

const PACK_IT: SafeLangPack = {
  headlines: (b) => [
    `${b} Sito Ufficiale`,
    `${b} — Negozio Online`,
    `Store ${b}`,
    `Visita ${b} Online`,
    `${b} — Catalogo`,
  ],
  descriptions: (b) => [
    `Scopri il catalogo ufficiale ${b} online con informazioni dettagliate sui prodotti.`,
    `Negozio ${b} online — dettagli prodotto chiari e servizio affidabile.`,
    `Sfoglia i prodotti ${b} online e scopri di più sul marchio.`,
    `Ulteriori informazioni su ${b} online — informazioni prodotto e assistenza clienti.`,
  ],
  sitelinks: {
    home: { title: "Home", desc1: "Pagina ufficiale", desc2: "Sfoglia online" },
    shop: { title: "Negozio", desc1: "Vedi i prodotti", desc2: "Negozio online" },
    contact: { title: "Contatti", desc1: "Assistenza clienti", desc2: "Contattaci" },
    about: { title: "Chi siamo", desc1: "Informazioni sul marchio", desc2: "Scopri di più" },
  },
  categoryWord: "prodotti",
};

const PACK_ES: SafeLangPack = {
  headlines: (b) => [
    `${b} Sitio Oficial`,
    `${b} — Tienda Online`,
    `Tienda ${b}`,
    `Visita ${b} Online`,
    `${b} — Catálogo`,
  ],
  descriptions: (b) => [
    `Descubre el catálogo oficial ${b} en línea con información detallada de los productos.`,
    `Tienda ${b} online — detalles claros del producto y servicio confiable.`,
    `Explora los productos ${b} en línea y obtén más información sobre la marca.`,
    `Más información sobre ${b} en línea — información del producto y atención al cliente.`,
  ],
  sitelinks: {
    home: { title: "Inicio", desc1: "Página oficial", desc2: "Explorar online" },
    shop: { title: "Tienda", desc1: "Ver productos", desc2: "Tienda online" },
    contact: { title: "Contacto", desc1: "Atención al cliente", desc2: "Ponte en contacto" },
    about: { title: "Sobre nosotros", desc1: "Sobre la marca", desc2: "Más información" },
  },
  categoryWord: "productos",
};

const PACK_PT: SafeLangPack = {
  headlines: (b) => [
    `${b} Site Oficial`,
    `${b} — Loja Online`,
    `Loja ${b}`,
    `Visite ${b} Online`,
    `${b} — Catálogo`,
  ],
  descriptions: (b) => [
    `Descubra o catálogo oficial ${b} online com informações detalhadas dos produtos.`,
    `Loja ${b} online — detalhes claros do produto e serviço confiável.`,
    `Explore os produtos ${b} online e saiba mais sobre a marca.`,
    `Saiba mais sobre ${b} online — informações do produto e atendimento ao cliente.`,
  ],
  sitelinks: {
    home: { title: "Início", desc1: "Página oficial", desc2: "Explorar online" },
    shop: { title: "Loja", desc1: "Ver produtos", desc2: "Loja online" },
    contact: { title: "Contato", desc1: "Atendimento ao cliente", desc2: "Fale conosco" },
    about: { title: "Sobre nós", desc1: "Sobre a marca", desc2: "Saiba mais" },
  },
  categoryWord: "produtos",
};

const PACK_ZH: SafeLangPack = {
  headlines: (b) => [
    `${b} 官方网站`,
    `${b} — 在线商店`,
    `${b} 官网`,
    `访问 ${b} 在线`,
    `${b} — 产品目录`,
  ],
  descriptions: (b) => [
    `访问 ${b} 官方在线目录，查看详细产品信息与客户支持。`,
    `${b} 在线商店，清晰的产品详情与可靠的服务支持。`,
    `浏览 ${b} 产品，在线了解品牌与相关信息。`,
    `了解更多 ${b} 官方信息 —— 产品详情与客户服务。`,
  ],
  sitelinks: {
    home: { title: "首页", desc1: "官方首页", desc2: "在线浏览" },
    shop: { title: "商店", desc1: "查看产品", desc2: "在线商店" },
    contact: { title: "联系", desc1: "客户支持", desc2: "联系我们" },
    about: { title: "关于", desc1: "关于品牌", desc2: "了解更多" },
  },
  categoryWord: "产品",
};

const PACKS: Record<string, SafeLangPack> = {
  en: PACK_EN,
  de: PACK_DE,
  fr: PACK_FR,
  nl: PACK_NL,
  it: PACK_IT,
  es: PACK_ES,
  pt: PACK_PT,
  "zh": PACK_ZH,
  "zh-CN": PACK_ZH,
  "zh-TW": PACK_ZH,
};

function pickPack(languageCode?: string, country?: string): SafeLangPack {
  if (languageCode) {
    const exact = PACKS[languageCode];
    if (exact) return exact;
    const lang = languageCode.split(/[-_]/)[0].toLowerCase();
    if (PACKS[lang]) return PACKS[lang];
  }
  if (country) {
    try {
      const cfg = getAdMarketConfig(country);
      const lang = (cfg.languageCode || "en").toLowerCase();
      if (PACKS[lang]) return PACKS[lang];
    } catch { /* fallback */ }
  }
  return PACK_EN;
}

function ensureMaxLen(text: string, maxLen: number): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen).replace(/[\s,\.\-·|]+$/, "").trim();
}

// ─── 主入口 ────────────────────────────────────────────

/**
 * 返回一条安全兜底标题（≤30 chars），index 控制选用哪条
 */
export function fillSafeHeadline(brandRoot: string, country?: string, languageCode?: string, index = 0): string {
  const pack = pickPack(languageCode, country);
  const arr = pack.headlines(brandRoot || "Official");
  const picked = arr[index % arr.length];
  return ensureMaxLen(picked, 30);
}

/**
 * 返回一条安全兜底描述（50-90 chars），index 控制选用哪条
 */
export function fillSafeDescription(brandRoot: string, country?: string, languageCode?: string, index = 0): string {
  const pack = pickPack(languageCode, country);
  const arr = pack.descriptions(brandRoot || "Official");
  let picked = arr[index % arr.length];
  if (picked.length > 90) picked = ensureMaxLen(picked, 90);
  // 确保最低 50 字符：如不足，追加通用词
  if (picked.length < 50) {
    picked = `${picked} Learn more about ${brandRoot}.`.slice(0, 90);
  }
  return picked;
}

export interface SafeSitelinkItem {
  title: string;
  url: string;
  desc1: string;
  desc2: string;
}

/**
 * 基于已知 URL 生成一条安全 Sitelink（不编造 URL，URL 由调用方提供）
 */
export function fillSafeSitelink(
  brandRoot: string,
  country: string | undefined,
  kind: "home" | "shop" | "contact" | "about",
  url: string,
  languageCode?: string,
): SafeSitelinkItem {
  const pack = pickPack(languageCode, country);
  const sl = pack.sitelinks[kind];
  return {
    title: ensureMaxLen(sl.title, 25),
    url,
    desc1: ensureMaxLen(sl.desc1, 35),
    desc2: ensureMaxLen(sl.desc2, 35),
  };
}
