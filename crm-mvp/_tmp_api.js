const https = require("https");

const loginBody = JSON.stringify({username:"wj07",password:"wj07123",role:"user"});
const opts = {
  hostname:"google-data-analysis.top", port:443, path:"/api/auth/login",
  method:"POST", headers:{"Content-Type":"application/json","Content-Length":Buffer.byteLength(loginBody)}
};
const req = https.request(opts, res => {
  let d="";
  res.on("data",c=>d+=c);
  res.on("end",()=>{ console.log("Login:", d.slice(0,800)); });
});
req.on("error",e=>console.error("ERR:",e.message));
req.write(loginBody); req.end();