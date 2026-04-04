const https = require("https");
const jwt = require("jsonwebtoken");

const SECRET = "crm-mvp-jwt-secret-2026-google-analysis";
const token = jwt.sign({ userId: "8", username: "wj07", role: "user" }, SECRET, { expiresIn: "1h" });

// 获取最近7天的campaigns数据
const today = new Date();
const yStr = new Date(today - 86400000).toISOString().slice(0,10);
const d7Str = new Date(today - 7*86400000).toISOString().slice(0,10);

function apiCall(path, cb) {
  const opts = {
    hostname: "google-data-analysis.top", port: 443, path,
    method: "GET", headers: { "Cookie": "user_token=" + token }
  };
  const req = https.request(opts, res => {
    let d = "";
    res.on("data", c => d += c);
    res.on("end", () => cb(null, d));
  });
  req.on("error", e => cb(e.message));
  req.end();
}

// 1. 获取昨日campaigns数据
apiCall(
  `/api/user/data-center/campaigns?date_start=${yStr}&date_end=${yStr}&page=1&page_size=50`,
  (err, data) => {
    if (err) { console.error("API1 ERR:", err); return; }
    try {
      const j = JSON.parse(data);
      if (j.code === 0) {
        const s = j.data.summary;
        console.log("=== 昨日数据 (" + yStr + ") ===");
        console.log("总花费:", s.totalCost, "佣金:", s.totalCommission, "点击:", s.totalClicks, "曝光:", s.totalImpressions, "订单:", s.totalOrders);
        console.log("广告系列:");
        (j.data.campaigns||[]).filter(c => c.cost > 0).forEach(c => {
          console.log("  -", c.campaign_name, "| cost:", c.cost, "| clicks:", c.clicks, "| comm:", c.commission, "| status:", c.status);
        });
      } else {
        console.log("API1 resp:", data.slice(0,300));
      }
    } catch(e) { console.log("API1 parse err:", e.message, data.slice(0,200)); }
  }
);

// 2. 获取近7天数据
setTimeout(() => {
  apiCall(
    `/api/user/data-center/campaigns?date_start=${d7Str}&date_end=${yStr}&page=1&page_size=50`,
    (err, data) => {
      if (err) { console.error("API2 ERR:", err); return; }
      try {
        const j = JSON.parse(data);
        if (j.code === 0) {
          const s = j.data.summary;
          console.log("\n=== 近7天数据 ===");
          console.log("总花费:", s.totalCost, "佣金:", s.totalCommission, "点击:", s.totalClicks, "曝光:", s.totalImpressions, "订单:", s.totalOrders);
          console.log("MCC分布:", JSON.stringify(j.data.costByMcc));
        } else {
          console.log("API2 resp:", data.slice(0,300));
        }
      } catch(e) { console.log("API2 parse err:", e.message, data.slice(0,200)); }
    }
  );
}, 500);