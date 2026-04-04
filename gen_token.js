var j = require('jsonwebtoken');
var secret = process.env.JWT_SECRET;
var t = j.sign({userId:'2',username:'wj01',role:'user'}, secret, {expiresIn:'1h'});
console.log(t);
