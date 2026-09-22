/**
 * scripts/mock-solver.cjs — e2e 用的假求解器。
 *
 * 取代 captcha/solver.cjs：不起 jsdom，直接吐一个可预期的 VERIFY_PARAM，
 * 并把「被调用了几次」追加到 MOCK_SOLVER_COUNTER 指向的文件里，
 * 供「验证码缓存命中」这一条断言使用。
 */

const fs = require('node:fs');

const counterFile = process.env.MOCK_SOLVER_COUNTER;
if (counterFile) {
  try {
    fs.appendFileSync(counterFile, `${Date.now()}\n`);
  } catch {
    /* 计数文件写不了不影响主流程 */
  }
}

const scene = process.argv[2] || '';
const region = process.argv[3] || '';
const prefix = process.argv[4] || '';

// 把入参也带进 verifyParam，便于断言「场景配置确实透传给了求解器」
console.log(`VERIFY_PARAM=mock|${scene}|${region}|${prefix}`);
process.exit(0);
