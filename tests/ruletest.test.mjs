// Unit-test rule retargeting, including the option-suffix and logical-rule
// cases that real subscriptions contain.
import { splitRule, retargetRule } from '../src/core/exporter.mjs';

const known = new Set(['🚀 节点选择', '♻️ 自动选择', '🔄 故障转移', 'DIRECT', 'REJECT', 'REJECT-DROP', 'PASS']);

const cases = [
  // [input, expected]
  ['DOMAIN-SUFFIX,services.googleapis.cn,闪电猫', 'DOMAIN-SUFFIX,services.googleapis.cn,🚀 节点选择'],
  ['IP-CIDR,91.108.4.0/22,闪电猫,no-resolve', 'IP-CIDR,91.108.4.0/22,🚀 节点选择,no-resolve'],
  ['IP-CIDR,10.0.0.0/8,DIRECT,no-resolve', 'IP-CIDR,10.0.0.0/8,DIRECT,no-resolve'],
  ['GEOIP,CN,DIRECT', 'GEOIP,CN,DIRECT'],
  ['MATCH,闪电猫', 'MATCH,🚀 节点选择'],
  ['MATCH,🚀 节点选择', 'MATCH,🚀 节点选择'],
  ['DOMAIN,ocsp.apple.com,♻️ 自动选择', 'DOMAIN,ocsp.apple.com,♻️ 自动选择'],
  // Logical rules: commas live inside parentheses.
  ['AND,((DOMAIN,a.com),(NETWORK,tcp)),闪电猫', 'AND,((DOMAIN,a.com),(NETWORK,tcp)),🚀 节点选择'],
  ['OR,((DOMAIN,a.com),(DOMAIN,b.com)),DIRECT,no-resolve', 'OR,((DOMAIN,a.com),(DOMAIN,b.com)),DIRECT,no-resolve'],
  ['NOT,((DOMAIN,a.com)),闪电猫', 'NOT,((DOMAIN,a.com)),🚀 节点选择'],
  ['DOMAIN-KEYWORD,google,REJECT', 'DOMAIN-KEYWORD,google,REJECT'],
  // Process/service rules keep their payload intact.
  ['PROCESS-NAME,chrome.exe,DIRECT', 'PROCESS-NAME,chrome.exe,DIRECT'],
  ['RULE-SET,reject,REJECT', 'RULE-SET,reject,REJECT'],
];

let pass = 0;
let fail = 0;

for (const [input, expected] of cases) {
  const actual = retargetRule(input, known, '🚀 节点选择');
  if (actual === expected) {
    pass++;
    console.log(`PASS  ${input}`);
  } else {
    fail++;
    console.log(`FAIL  ${input}\n        expected: ${expected}\n        actual:   ${actual}`);
  }
}

// splitRule sanity
const s = splitRule('AND,((DOMAIN,a.com),(NETWORK,tcp)),PROXY');
if (s.length === 3 && s[0] === 'AND' && s[1] === '((DOMAIN,a.com),(NETWORK,tcp))' && s[2] === 'PROXY') {
  pass++;
  console.log('PASS  splitRule keeps logical operands intact');
} else {
  fail++;
  console.log('FAIL  splitRule:', JSON.stringify(s));
}

console.log(`\n${pass} passed, ${fail} failed`);
console.log('RULE_TEST_DONE');
process.exit(fail ? 1 : 0);
