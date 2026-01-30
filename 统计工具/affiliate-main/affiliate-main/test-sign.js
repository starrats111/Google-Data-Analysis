// 测试sign函数是否正确
const crypto = require('crypto');

function generateSign(data) {
  const salt = 'TSf03xGHykY';
  const combined = data + salt;
  const hash = crypto.createHash('md5').update(combined, 'utf-8').digest('hex');
  return hash;
}

// 测试用例
console.log('🧪 Sign函数测试\n');
console.log('=' .repeat(60));

// 测试1: 简单字符串
const test1 = 'hello';
const sign1 = generateSign(test1);
console.log('\n测试1: 简单字符串');
console.log(`输入: ${test1}`);
console.log(`输出: ${sign1}`);
console.log('Python对比: 运行 python -c "import hashlib; print(hashlib.md5(\'helloTSf03xGHykY\'.encode()).hexdigest())"');

// 测试2: 登录参数
const username = 'omnilearn';
const password = 'Ltt.104226';
const code = '1234';
const remember = '1';
const timestamp = '1234567890';

const loginData = username + password + code + remember + timestamp;
const sign2 = generateSign(loginData);

console.log('\n测试2: 登录参数');
console.log(`输入数据: ${loginData}`);
console.log(`计算的sign: ${sign2}`);

// 测试3: 报表查询参数
const startDate = '2024-12-01';
const endDate = '2024-12-31';
const page = '1';
const pageSize = '2000';
const exportFlag = '0';

const reportData = `m_id${startDate}${endDate}${page}${pageSize}${exportFlag}`;
const sign3 = generateSign(reportData);

console.log('\n测试3: 报表查询参数');
console.log(`输入数据: ${reportData}`);
console.log(`计算的sign: ${sign3}`);

console.log('\n' + '='.repeat(60));
console.log('✅ Sign函数测试完成');
console.log('\n💡 如果有Python环境，可以运行以下命令对比结果:');
console.log(`   python -c "import hashlib; print(hashlib.md5('${loginData}TSf03xGHykY'.encode()).hexdigest())"`);
